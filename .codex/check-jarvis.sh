#!/usr/bin/env bash
cd /d/codes/vscode-agent-orchestrator
P="./.ui-check/tools/probe.ts"
echo "== grid";   bun $P jarvis 2>&1 | tail -1
echo "== fit";    bun $P jarvis --fit 2>&1 | tail -1
echo "== faces";  bun $P jarvis --faces 2>&1 | tail -1
for a in happy dance fly; do echo "== motion $a"; bun $P jarvis --motion $a 2>&1 | tail -1; done
echo "== zoom upper"; bun $P jarvis --zoom idle 5.6 0.35 2>&1 | tail -1; cp .ui-check/glb-bot/probe-jarvis-zoom-idle.png .ui-check/glb-bot/check-upper.png
echo "== zoom legs";  bun $P jarvis --zoom "walk 0.3" 1.6 0.35 2>&1 | tail -1
echo "== relief";     bun ./.ui-check/tools/relief.ts jarvis 2>&1 | grep "open edges"
echo "== stretch";    bun $P jarvis --stretch 2>&1 | grep "stretch:"
echo "== done"
