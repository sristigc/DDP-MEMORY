---
name: viewer-proxy
title: agentmemory viewer
group: edge
icon: shield
railway: agentmemory viewer
description: Caddy with a password login. Routes /galaxy to the graph, /agent to the runner, everything else to the agentmemory viewer.
health: ${VIEWER_URL}/
healthOk: [200, 401]
calls: [galaxy, agent-runner, agentmemory]
---
Source: viewer-proxy/. Public domain on port 80.
