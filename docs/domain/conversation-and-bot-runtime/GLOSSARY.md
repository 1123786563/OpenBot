# Conversation and Bot Runtime Glossary

## Conversation

A user-facing exchange with a Bot. The product presents a conversation as a channel and stores its messages, participants, selected Bot, and activity.

## Channel

The durable conversation container used by the workspace. A channel may be private to a person, shared with a group, or connected to a delivery surface.

## Thread

A focused execution context within a conversation. A thread carries the messages and runtime state needed to continue a Bot interaction.

## Turn

One request-and-response cycle in a conversation. A turn may stream text, invoke tools, request approval, or wait for a person.

## Bot run

The Bot's execution of a turn or an automated instruction. A run can be active, paused, waiting for input, refused, completed, or failed.

## Group conversation

A conversation shared by multiple people and a Bot. Membership controls who can see and continue it.

## Attachment

A file or other user-provided content associated with a message. An attachment is stored and made available to the Bot only when the run can safely read it.

## Handoff

A controlled transfer of work between Bot runtimes or between a Bot and a person.

## Model choice

The model configuration used for a Bot run. The selected model is constrained by the deployment's available providers and policies.
