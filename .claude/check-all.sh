#!/usr/bin/env bash
cd /d/codes/vscode-agent-orchestrator
P=".claude/skills/glb-bot/scripts/probe.ts"
echo "== jarvis grid";      bun $P jarvis 2>&1 | tail -2
echo "== jarvis fit";       bun $P jarvis --fit 2>&1 | tail -1
echo "== jarvis faces";     bun $P jarvis --faces 2>&1 | tail -1
for a in happy dance fly; do echo "== jarvis motion $a"; bun $P jarvis --motion $a 2>&1 | tail -1; done
echo "== jarvis zoom upper"; bun $P jarvis --zoom idle 5.6 0.35 2>&1 | tail -1; cp .ui-check/glb-bot/probe-jarvis-zoom-idle.png .ui-check/glb-bot/check-upper.png
echo "== jarvis zoom legs";  bun $P jarvis --zoom "walk 0.3" 1.6 0.35 2>&1 | tail -1
echo "== jarvis relief";     bun .claude/skills/glb-bot/scripts/relief.ts jarvis 2>&1 | grep "open edges"
for b in jocy ally vally meshy buddy; do
  echo "== $b grid";    bun $P $b 2>&1 | tail -1
  echo "== $b stretch"; bun $P $b --stretch 2>&1 | grep "stretch:"
  echo "== $b fit";     bun $P $b --fit 2>&1 | tail -1
done
echo "== done"
