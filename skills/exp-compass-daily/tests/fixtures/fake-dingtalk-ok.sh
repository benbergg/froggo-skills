#!/usr/bin/env bash
# Fake dingtalk-log get-template stub for resolve-template integration test.
# Ignores args, echoes fixture JSON to stdout, exits 0.
cat "$(dirname "$0")/template-getbyname-ok.json"
