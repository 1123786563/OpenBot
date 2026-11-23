---
status: accepted
---

# Use Agent Sandbox and AgenticFS for the Personal SaaS Computer pilot

Use Alibaba Cloud Agent Sandbox Flash Edition to run the Personal SaaS managed Computer and AgenticFS to hold its files. The pilot replaces the Docker supervisor and the dedicated ext4 mount for each participating workspace. It starts with the existing file tools for listing, reading, and writing files. See the [current trial storage setup](../personal-saas-trial.md#provision-computer-storage) and [AgenticFS mounts](https://help.aliyun.com/zh/agent-sandbox/mount-agenticfs-dynamically).

## Workspace files and quota

Give each pilot workspace its own AgenticSpace and Access Point. Bind both to the workspace ID so that opening a new workspace after closure creates a new file space. Set the Computer quota to 10 GiB, the minimum supported by the AgenticSpace creation API. Set the combined storage limit to the existing conversation attachment allowance plus the Computer quota. AgenticFS bills by actual storage use. [AgenticSpace quota](https://help.aliyun.com/zh/nas/developer-reference/api-nas-2017-06-26-createagenticspace) · [AgenticFS billing](https://help.aliyun.com/zh/nas/product-overview/billing-of-agenticfs)

## Start, stop, and closure

The workspace owner starts and stops the Computer explicitly. Start creates a sandbox and mounts the workspace's existing files. Stop destroys the sandbox and keeps the files. Workspace closure also removes the workspace's AgenticSpace and verifies cleanup under the [existing closure contract](../personal-saas-trial.md#workspace-closure-cleanup-and-disaster-recovery).

OpenBot owns the account authorization checks and the existing 15-second Computer lease. The pilot must verify on the target cloud that the sandbox process exits by the lease deadline if renewal stops. Record when the process exits and when OpenBot can confirm it. Use the [target-cloud cutoff scenarios](../personal-saas-trial.md#run-target-cloud-acceptance) for account disablement and Computer control plane loss.

## Pilot acceptance

Use two newly created trial workspaces. In one workspace, write a file through the existing Computer tool, stop the Computer, and read back the same bytes after starting a new sandbox. Verify that the second workspace cannot list or read the first workspace's files. Exercise quota refusal and confirm the original attachment allowance. Record the confirmed exit of the old sandbox after account disablement. Migration and rollback for existing Docker workspace data are a separate decision after these checks pass.
