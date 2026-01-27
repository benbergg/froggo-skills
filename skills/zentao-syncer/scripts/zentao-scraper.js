/**
 * Zentao Task/Bug Scraper
 *
 * 用法: ZENTAO_ID=T42093 node run.js /path/to/zentao-scraper.js
 * 示例: ZENTAO_ID=T42093 node run.js zentao-scraper.js
 *       ZENTAO_ID=B5678 node run.js zentao-scraper.js
 *
 * 环境变量:
 *   ZENTAO_ID       - 任务或Bug ID（必需）
 *   ZENTAO_USER     - 禅道用户名（必需）
 *   ZENTAO_PASSWORD - 禅道密码（必需）
 *
 * 输出: JSON 格式的任务/Bug 详情
 */

const { chromium } = require('playwright');

// 禅道 URL 配置
const ZENTAO_BASE = 'https://chandao.bytenew.com/zentao';
const ZENTAO_LOGIN_URL = `${ZENTAO_BASE}/user-login`;

// 从环境变量获取配置
const zentaoId = process.env.ZENTAO_ID;
const zentaoUser = process.env.ZENTAO_USER;
const zentaoPassword = process.env.ZENTAO_PASSWORD;

// 检查必需的环境变量
if (!zentaoId) {
  console.error('错误: 请设置 ZENTAO_ID 环境变量，如 ZENTAO_ID=T42093');
  process.exit(1);
}

if (!zentaoUser || !zentaoPassword) {
  console.error('错误: 请设置 ZENTAO_USER 和 ZENTAO_PASSWORD 环境变量');
  console.error('示例: ZENTAO_USER=your_username ZENTAO_PASSWORD=your_password ZENTAO_ID=T42093 node run.js zentao-scraper.js');
  process.exit(1);
}

// 解析 ID 类型
const idMatch = zentaoId.match(/^([TB])(\d+)$/i);
if (!idMatch) {
  console.error('错误: ID 格式无效，应为 T1234（任务）或 B5678（Bug）');
  process.exit(1);
}

const type = idMatch[1].toUpperCase() === 'T' ? 'task' : 'bug';
const numericId = idMatch[2];
const url = `${ZENTAO_BASE}/${type}-view-${numericId}.html`;

// CSS 选择器配置
const SELECTORS = {
  // 通用字段
  title: '#mainContent .main-header h2, #mainContent h2.title',

  // 任务页面选择器
  task: {
    priority: 'th:has-text("优先级") + td, td:has-text("优先级") + td',
    estimate: 'th:has-text("预计") + td, td:has-text("预计") + td',
    assignee: 'th:has-text("指派给") + td, td:has-text("指派给") + td',
    status: 'th:has-text("任务状态") + td, td:has-text("状态") + td',
    startDate: 'th:has-text("预计开始") + td',
    deadline: 'th:has-text("截止日期") + td',
    execution: 'th:has-text("所属执行") + td',
    story: 'th:has-text("相关需求") + td a, td:has-text("相关需求") + td a',
    description: '.detail-content .article-content, #actionbox .content, .tab-content .article-content',
  },

  // Bug 页面选择器
  bug: {
    priority: 'th:has-text("优先级") + td',
    severity: 'th:has-text("严重程度") + td',
    assignee: 'th:has-text("指派给") + td',
    status: 'th:has-text("Bug状态") + td, th:has-text("状态") + td',
    product: 'th:has-text("所属产品") + td',
    module: 'th:has-text("所属模块") + td',
    description: '.detail-content .article-content, #actionbox .content',
  }
};

/**
 * 确保已登录禅道
 * 先访问登录页，检测登录状态，未登录则自动登录
 */
async function ensureLogin(page) {
  console.log('正在检查登录状态...');

  // 访问登录页
  await page.goto(ZENTAO_LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });

  // 检测是否在登录页（未登录状态）
  const currentUrl = page.url();
  const isLoginPage = currentUrl.includes('user-login');

  if (!isLoginPage) {
    console.log('已登录，跳过登录步骤');
    return true;
  }

  console.log('未登录，正在自动登录...');

  // 等待登录表单加载
  await page.waitForSelector('input[name="account"]', { timeout: 10000 });

  // 填入用户名和密码
  await page.fill('input[name="account"]', zentaoUser);
  await page.fill('input[name="password"]', zentaoPassword);

  console.log(`使用账号 ${zentaoUser} 登录...`);

  // 点击登录按钮
  await page.click('button:has-text("登录")');

  // 等待登录完成（URL 不再包含 user-login）
  try {
    await page.waitForURL(url => !url.includes('user-login'), { timeout: 15000 });
    console.log('登录成功');
    return true;
  } catch (error) {
    // 检查是否有错误提示
    const errorMsg = await page.evaluate(() => {
      const alert = document.querySelector('.alert-danger, .error, .tips-error');
      return alert ? alert.textContent.trim() : null;
    });

    if (errorMsg) {
      console.error(`登录失败: ${errorMsg}`);
    } else {
      console.error('登录失败: 超时或未知错误');
    }
    return false;
  }
}

(async () => {
  console.log(`正在抓取禅道${type === 'task' ? '任务' : 'Bug'}: ${zentaoId}`);
  console.log(`URL: ${url}`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  try {
    // 先确保登录
    const loginSuccess = await ensureLogin(page);
    if (!loginSuccess) {
      throw new Error('登录失败，请检查用户名和密码');
    }

    // 访问目标页面
    console.log(`正在访问: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // 等待页面内容加载
    await page.waitForTimeout(1000);

    // 关闭可能的弹窗
    try {
      const closeBtn = await page.$('.modal .close, .modal-close, [data-dismiss="modal"]');
      if (closeBtn) await closeBtn.click();
    } catch (e) {}

    // 抓取数据
    const selectors = type === 'task' ? SELECTORS.task : SELECTORS.bug;

    const result = await page.evaluate((opts) => {
      const { type, selectors, titleSelector, zentaoId } = opts;

      // 辅助函数：获取文本
      const getText = (selectorStr) => {
        const sels = selectorStr.split(', ');
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel);
            if (el) return el.textContent.trim();
          } catch (e) {}
        }
        return '';
      };

      // 辅助函数：获取链接
      const getLink = (selectorStr) => {
        const sels = selectorStr.split(', ');
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              return {
                text: el.textContent.trim(),
                href: el.href || ''
              };
            }
          } catch (e) {}
        }
        return null;
      };

      // 基础数据
      const data = {
        id: zentaoId,
        type: type,
        title: getText(titleSelector),
        priority: getText(selectors.priority),
        assignee: getText(selectors.assignee),
        status: getText(selectors.status),
        description: getText(selectors.description),
      };

      // 任务特有字段
      if (type === 'task') {
        data.estimate = getText(selectors.estimate);
        data.startDate = getText(selectors.startDate);
        data.deadline = getText(selectors.deadline);
        data.execution = getText(selectors.execution);
        data.relatedStory = getLink(selectors.story);
      }

      // Bug 特有字段
      if (type === 'bug') {
        data.severity = getText(selectors.severity);
        data.product = getText(selectors.product);
        data.module = getText(selectors.module);
      }

      return data;
    }, {
      type,
      selectors,
      titleSelector: SELECTORS.title,
      zentaoId
    });

    // 如果标题为空，尝试其他方式获取
    if (!result.title) {
      result.title = await page.evaluate(() => {
        // 尝试从页面标题获取
        const pageTitle = document.title;
        if (pageTitle && !pageTitle.includes('登录')) {
          return pageTitle.replace(/ - 禅道.*$/, '').trim();
        }
        // 尝试从 h2 获取
        const h2 = document.querySelector('h2');
        return h2 ? h2.textContent.trim() : '';
      });
    }

    // 截图备用
    await page.screenshot({
      path: `/tmp/zentao-${zentaoId}.png`,
      fullPage: true
    });
    console.log(`截图已保存: /tmp/zentao-${zentaoId}.png`);

    // 输出 JSON 结果
    console.log('\n===== 抓取结果 =====');
    console.log(JSON.stringify(result, null, 2));

    // 保存到文件
    require('fs').writeFileSync(
      `/tmp/zentao-${zentaoId}.json`,
      JSON.stringify(result, null, 2)
    );
    console.log(`\nJSON 已保存: /tmp/zentao-${zentaoId}.json`);

  } catch (error) {
    console.error('抓取失败:', error.message);
    await page.screenshot({ path: `/tmp/zentao-${zentaoId}-error.png`, fullPage: true });
    console.log(`错误截图: /tmp/zentao-${zentaoId}-error.png`);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
