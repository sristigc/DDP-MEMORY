---
name: agent-runner
title: agent-runner
group: workers
icon: cog
railway: agent-runner
description: Claims queued jobs and runs steps 1–9 (dry-run for now). Pauses at the local logs step until resumed.
health: ${RUNNER_URL}/healthz
calls: [postgres, agentmemory, notifier]
---
Source: agent/agent-runner/. Jobs API at /agent/jobs behind the login.
