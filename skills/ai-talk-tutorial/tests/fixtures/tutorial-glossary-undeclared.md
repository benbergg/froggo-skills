# 在大模型预训练中活下来:合成数据模块化与三个未公开的工程 bug

## 一、TL;DR

- poolside 把"合成数据"做成一套模块化管道 (Hive),占总混合 13% (pre-training only),靠"拆解任务、降低对 teacher model 的依赖"扩展数据生成能力,目前已生成持续增长的 6T token 语料。
- 大规模分布式训练"看不见的 bug"在 10^11 参数 + 4000 GPU 规模才显形:broken GPU 静默数据损坏、BF16 accumulation 在 LM head 处精度耗尽、FP8 kernel race condition 让 0.5% 梯度被随机值替换。
- 工程上的核心做法是"不要相信任何东西":用 model replica hash 在每次迭代比对所有副本权重,一旦不一致立即 crash;对 LM head 的 tensor parallel accumulation 强制 FP32;对 DeepChem FP8 kernel 的 race condition 提供 PR 修复。
- 真正的可观测性是 hash + 数值精度 + race condition 检测三位一体,任何一环缺失都会让训练在"看起来没事"的情况下彻底跑偏。
- XGen-2 (Laguna XS, 33B) 和 Laguna S (118B/8B 激活, 30T tokens, 4000 GPU) 都会开源;33B 在 coding 上超过同尺寸开源模型,Laguna S 在 swe-bench agentless multilingual 上显著领先所有对比对象。

## 二、背景 · 他要解决什么问题

poolside 刚把开源模型 Laguna M 和 Laguna XS (即 XGen-2) 放在 Hugging Face 上,从纯企业版本转向对所有人开放。本次演讲由数据负责人 Marah Abdin 和分布式训练负责人 Robert McHardy 共同主讲,核心命题是:Laguna M.1 → M.2 / XS 的跨越过程中,他们到底踩了哪些"只有规模到了才会暴露"的坑。

对 Marah 来说,问题是"小规模高质量"直觉在规模放大后破产。Laguna M 早期训练数据偏向精选高质量集合,但当训练预算放大后,这些高质量数据上的非最优重复让模型过早饱和,token uniqueness 问题开始凸显。同时,纯靠 organic data 不能显式呈现"implicit rationale / planning / structure"这类模型真正需要的能力 —— 这些特征隐含在原始数据里,被表达得不那么理想。合成数据给了 poolside 一条"把这些隐含特征抽出来、投到新平面"的轨道,既能补缺,也能正则化"我们怎么呈现 tokens / 怎么教模型"。

对 Robert 来说,问题是"分布式训练的不变量"在千卡规模上会被基础设施 bug 击穿。Broken GPU 会让 loss 曲线出现 spiky bump;BF16 在 LM head 处的 tensor parallel accumulation 会因为激活值不断增长而耗尽精度,模型在 ~50000 步后停止收敛;FP8 training 的 DeepChem 内核有 race condition,会让约 0.5% 的梯度被静默替换成随机值。这三种问题在 10B / 几百卡规模完全看不出来,但到 118B / 4000 GPU 时就会让训练实质失效 —— 这也是为什么他们把 Laguna XS 当作"试验床",先在 33B 把所有数据 + 数值修复验证一遍,再放大到 Laguna S。

## 三、核心方法论

### 1. 合成数据的模块化管道:六个组件 + 四种形状

Marah 把每一个合成数据 pipeline 都抽象成六个组件:**seeds、primary inputs、metadata、secondary inputs、generator**(可以是一个带 tool 的 agent,也可以是一个带 prompt template 的模型调用)、**supplementary functions**(过滤器和校验器)。这个抽象覆盖了从最便宜的改写管道到最昂贵的多阶段工作流的所有复杂度光谱。

在管道形状上有四种典型。**rephrasing**(多模改写,降低重复 token)是最便宜的;**multi-stage workflows** 把一个复杂任务拆成多个 step 聚合生成 —— 写小说时先生成 setting / 角色名 / 风格 / 剧情 / 转折,再逐章生成,这种"逐步构建"几乎在所有复杂文档生成上都能拿到更好结果;**cross-domain porting** 做跨模态改写,典型例子是代码翻译、poolside 实际做过的"把数学题转成代码";**multi-turn role** 是迭代式生成 —— 两个 agent 对话、judge + evolver 反复迭代 K 轮,这其实是上面所有形状的封装。

> [!tip]
> 关键工程法则:**如果任务对模型太难,模型就会崩,失去正确性、失去多样性。所以要拆解任务,让它更简单。** 这条规则决定了合成数据架构可以"激进"的边界 —— cheap scalable pipeline 靠种子就能跑,expensive orchestrated pipeline 才需要多智能体编排;任何 teacher model 跑不动的任务都应该先拆,而不是堆算力。

### 2. Hive:可配置的多 agent 队列 + 编排器 + 监督者

为了把这些模块化管道"基础设施化",poolside 做出了 Hive:**一个 agent 队列 + 编排器 + 监督者**的三层结构。每个 agent 自带 prompt、参数、模型、输入输出,以及"何时入队 / 出队 / 频率"的控制;orchestrator 在 agent 之间做编排,可以动态改写下一轮的指令、决定哪个 agent 下一个上场、哪个跳过 —— 让 LLM 之间呈现层级关系的同时保留一定创造性;最外层还有 supervisor,对 orchestrator 做全局视角的纠察。

这套结构让 poolside 不被任何单一 teacher model 卡脖子。任务可以拆给多个不同能力的 agent 接力完成,符合上一节的"拆解任务"原则。Hive 本身是对 Marah 整套模块化管道的工程化落地,让"换管道"这件事从"重写脚本"变成"换 agent 队列配置"。

### 3. 分布式训练的可观测性:hash + 精度 + race condition

Robert 团队的工程信条是 **"we don't trust anything"**。在 10^10 ~ 10^11 参数 + 4000 GPU 规模上,"一切都会出错",所以任何不变量都要主动校验,不能假设它成立。具体落到三个抓手。

**第一,model replica hash。** DDP 训练中所有副本权重必须一致 —— 这个不变量用权重 hash 周期比对来验证。一旦 hash 不一致,训练立即 crash(因为"这种情况绝不应该发生")。这个看似粗暴的检查在 4000 GPU 规模上捕获了 broken GPU 引发的 silent data corruption:模型配置、数据、训练实现完全相同的两条曲线,只是因为某次训练不幸包含了一块坏 GPU,loss 就变得 spiky、gradient norm 暴增。poolside 在 Laguna M.1 训练里就靠这个机制拦下了。

**第二,精度护栏。** Laguna M.1 的紫色曲线在 ~50000 步后停滞 —— 根因是 LM head 的 tensor parallel accumulation 用了 BF16,而激活值规模持续增长,BF16 精度在 LM head 处耗尽,错误反向传播到整个模型 trunk,模型从此无法学习。修复极其简单:**把 accumulation 切到 FP32,模型立即恢复收敛,gradient norm 从增长趋势转为下降**。这个 bug 在小规模完全看不见,只有规模上去才会暴露,而且一旦命中会把整条曲线彻底废掉。

**第三,race condition 检测。** Laguna S 引入 FP8 training(基于 DeepChem 开源 FP8 kernel)时,撞到了 illegal memory access 与 NaN gradient。深挖后发现是 FP8 kernel 内的 race condition,会**让约 0.5% 的梯度被静默替换成随机值** —— 没有 hash 比对、没有异常监测就完全发现不了。poolside 在 PR 里提供了修复,并指出这是现有 hash 检查的盲点:真实训练没有"两份相同输入跑不同副本"这种冗余,所以前向 + 反向的一致性无法直接 hash。他们正在做"hash checker 至少做 dry run"的能力来补这个洞。

### 4. 规模放大实验:Laguna XS → Laguna S

XGen-2(Laguna XS, 33B 参数)作为"试验床"承担了所有数据改进、数值修复、可观测性增强的端到端验证。然后他们把它放大到 Laguna S(预览版,即将开源):**118B 总参数 / 8B 激活参数 / 30T tokens / 4000 GPUs**。scale 上去后,之前在数据 + 数值 + 可观测性上的所有改进都被验证"hold 得住",除了 FP8 race condition 这个与规模无关的倒霉 bug。

评估上,他们明确用的是 base model evals —— 部分预示 final model 表现,但 post-training 还会改写,不会完全一对一。重点看 coding 维度:MultiPL-E / BigCodeBench 上 Laguna S 强于 XGen-2,也强于更大的 Laguna M.1,并超过 GLM 4.5 Air、Qwen3-360、DeepSeek V4 Flash Max 等对比对象。**swe-bench agentless multilingual** 上 Laguna S 显著领先所有对比对象,这是他们用来 proxy 预训练期 agentic 表现的 benchmark。Big Bench Hard 和 EvalPlus 上接近 top 但未夺冠。MMLU Pro 不在他们重点关注范围,因为专注 agentic coding;他们也承认这是"数据缺口,想补就能补"。

## 四、常见误区

- 先挑模型再补评估 → 先用真实失败样本建评估集，再让评估结果去挑模型
- 评估集一次建好就不再动 → 每次线上出新的失败形态就把它补进评估集
- 用感觉判断模型换代有没有变好 → 在同一套评估集上跑完整对比，只认数据

## 五、可落地 checklist

- [ ] 把合成数据管道抽象成六个组件:seeds、primary inputs、metadata、secondary inputs、generator(agent or prompt template)、supplementary functions(filters / validators)。所有新管道都从这套抽象里组装,而不是堆 ad-hoc 脚本。
- [ ] 设定合成数据占总混合的预算比例(参考 poolside 的 13%,仅 pre-training),同时强制 teacher model 在拆解后的子任务上验证 correctness + diversity,任务过难就拆得更细。
- [ ] 给管道选型做"复杂度光谱"分层:能靠种子搞定的 rephrasing 走 cheap scalable 路径,需要多 agent 编排的复杂任务(教育数据、长篇创作)才上 expensive orchestrated 路径。
- [ ] 把合成数据管道基础设施化成"Hive 类"的多 agent 队列 + 编排器 + 监督者结构,让换管道从"重写脚本"变成"改 agent 配置"。
- [ ] 在 DDP 训练里实现 model replica hash:每次迭代或每 N 次迭代比对所有副本权重,不一致就 crash —— 这是捕获 broken GPU 这类 silent corruption 的最廉价手段。
- [ ] 检查所有 tensor parallel 下的 cross-rank accumulation:BF16 在 LM head / unembedding 处一旦激活规模增长就会精度耗尽,直接切 FP32(参考 poolside Laguna M.1 的修复路径)。
- [ ] 引入 FP8 / 低精度训练前,对 kernel 做 race condition 验证,关注 illegal memory access 与 NaN gradient;设计"前向 + 反向一致性"的可观测性(poolside 提到的 hash checker dry run 方向)。
- [ ] 选评测基准时区分"训练期 proxy"和"最终模型判定" —— poolside 用 swe-bench agentless multilingual 当 pre-training 期的 agentic coding proxy,而不是直接看 MMLU Pro 这种饱和知识题。
- [ ] 把"数据改进"和"训练代码正确性 + 数值精度"当成一个整体看待,不要分别优化 —— 这是 Robert 强调的 holistic 原则,单边改进会被另一边抵消。

## 六、落地到你的场景

如果你手上已经有一个跑在生产上的 agent，最小的起步动作是把最近一段时间的客诉和人工兜底记录翻出来，从里面挑出真正出错的请求，原样存成用例。不需要一开始就追求覆盖率，先把"改动之后能不能重跑一遍"这条路打通，比用例数量重要得多。

等到重跑变成一件不费力的事，再回头扩充评估集的覆盖面。此时你会发现，决定要不要换模型、要不要改提示词这类问题，已经从争论变成了看一眼对比结果就能定的事。

## 七、原声金句

> [5:56] "Because the rule of thumb is if task is too hard for your model, then your model will start to fall on its face. Lose correctness, lose diversity. So break down the task, make it simpler."
> —— 中文译解:核心工程直觉 —— 任务过难模型就崩,所以要持续拆解。poolside 所有合成数据架构之所以"敢做激进编排",根植于这条规则。

> [9:32] "Um and the way we we look at things in my team is uh we don't trust anything. There's so many things that can go wrong when you scale models to billions of parameters to hundreds of billions of parameters um training on thousands of GPUs and so on."
> —— 中文译解:分布式训练的工程信条 —— 在 10^10 ~ 10^11 参数 + 4000 GPU 规模上,"一切都会出错",所以任何不变量都要主动校验,不能假设它成立。

> [10:57] "And there's actually no difference uh in terms of model configuration, training data, training implementation um between these runs. They're exactly the same run. Just in one of them we were got unlucky and we had a broken GPU included. That broken GPU caused silent data corruption and um therefore made the training behave the way it did."
> —— 中文译解:model replica hash 之所以必要 —— 配置、数据、代码完全相同的两条曲线,因为一块坏 GPU 引入 silent data corruption 就表现得完全不同,这种 bug 只有 hash 比对能抓。

> [12:25] "So, we took the checkpoint from the purple curve. We moved that accumulation into FP32 and from there on the model started converging again."
> —— 中文译解:BF16 accumulation 在 LM head 处精度耗尽是 Laguna M.1 训练停滞的根因 —— 把 accumulation 切到 FP32,模型立刻恢复收敛。这种"一行修复"建立在先把根因定位到数值精度上。