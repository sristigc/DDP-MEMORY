---
name: notifier
title: notifier
group: integrations
icon: chat
railway: notifier
description: Sends job updates and PR links to my personal Google Chat.
health: ${NOTIFIER_URL}/healthz
---
Source: agent/notifier/. Needs GCHAT_WEBHOOK_URL.
