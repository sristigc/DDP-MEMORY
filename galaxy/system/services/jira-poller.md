---
name: jira-poller
title: jira-poller
group: workers
icon: clock
railway: jira-poller
cron: 0 */5 * * *
description: Every 5 hours, fetches Jira tickets assigned to me and queues one job per ticket.
calls: [postgres, notifier]
---
Source: agent/jira-poller/. Needs JIRA_EMAIL + JIRA_API_TOKEN.
