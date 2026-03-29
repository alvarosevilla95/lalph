---
"lalph": patch
---

Add GitHub parent issue selection for PR-flow GitHub projects, including
project configuration, direct child issue discovery, parent-aware `lalph plan`
bootstrapping, automatic child linking for `lalph issue`, and spec-aware worker
and reviewer prompts. This also tightens GitHub-only wiring so non-GitHub paths
do not carry unnecessary GitHub service dependencies.
