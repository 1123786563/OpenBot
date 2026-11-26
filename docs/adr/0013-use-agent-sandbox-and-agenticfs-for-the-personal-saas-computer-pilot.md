---
status: accepted
---

# Use Agent Sandbox and AgenticFS for the Personal SaaS Managed Computer pilot

Use Alibaba Cloud Agent Sandbox Flash Edition to run the Personal SaaS Managed Computer and AgenticFS to hold its files. The pilot replaces the Docker supervisor and the dedicated ext4 mount for each participating workspace. It starts with the existing file tools for listing, reading, and writing files. See the [current trial storage setup](../personal-saas-trial.md#provision-computer-storage) and [AgenticFS mounts](https://help.aliyun.com/zh/agent-sandbox/mount-agenticfs-dynamically).

## Workspace files and quota

Give each pilot workspace its own AgenticSpace and Access Point. Bind both to the workspace ID so that opening a new workspace after closure creates a new file space. Set the Computer quota to 10 GiB, the minimum supported by the AgenticSpace creation API. Set the combined storage limit to the existing conversation attachment allowance plus the Computer quota. AgenticFS bills by actual storage use. [AgenticSpace quota](https://help.aliyun.com/zh/nas/developer-reference/api-nas-2017-06-26-createagenticspace) · [AgenticFS billing](https://help.aliyun.com/zh/nas/product-overview/billing-of-agenticfs)

## Start, stop, and closure

The workspace owner starts and stops the Computer explicitly. Start creates a sandbox and mounts the workspace's existing files. Stop destroys the sandbox and keeps the files. Workspace closure also removes the workspace's AgenticSpace and verifies cleanup under the [existing closure contract](../personal-saas-trial.md#workspace-closure-cleanup-and-disaster-recovery).

OpenBot owns the account authorization checks and the existing 15-second Computer lease. A watchdog inside the cloud sandbox must stop the OpenBot work process by the lease deadline if renewal stops. The pilot must verify actual work process exit on the target cloud. Destroy the cloud instance separately and hold the workspace Computer slot until Alibaba Cloud confirms destruction. Record the lease deadline, work process exit, and instance destruction confirmation separately. In the Hangzhou pilot, the native Sandbox timeout returned approximately 60 seconds for both a 10-second create timeout and a 5-second timeout update. Fresh commands still ran after 15 seconds. [Cloud probe results](https://github.com/1123786563/OpenBot/pull/148) Use the [target-cloud cutoff scenarios](../personal-saas-trial.md#run-target-cloud-acceptance) for account disablement and Computer control plane loss.

## Pilot acceptance

Use two newly created trial workspaces. In one workspace, write a file through the existing Computer tool, stop the Computer, and read back the same bytes after starting a new sandbox. Verify that the second workspace cannot list or read the first workspace's files. Exercise quota refusal and confirm the original attachment allowance. Record work process exit by the lease deadline after account disablement and confirm destruction of the old instance before releasing its slot. Migration and rollback for existing Docker workspace data are a separate decision after these checks pass.
