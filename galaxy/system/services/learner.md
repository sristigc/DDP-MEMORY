---
name: learner
title: learner
group: workers
icon: graph
railway: learner
cron: 30 */2 * * *
description: Every 2 hours, scores finished agent jobs from real Jira outcomes (done/QA +, reopened −), reinforces lessons and saves them to team memory.
calls: [postgres, agentmemory, notifier]
---
Source: agent/learner/. The runner applies the strongest lessons for the ticket, project and global scope in step 1.
