# Computer and Browser Glossary

## Computer

The Bot's execution environment for browser, terminal, file, and other computer actions. Each Bot has a computer context with its own access boundaries.

## Managed Computer

A Computer assigned to a Personal SaaS workspace. The workspace owner can start and stop it, and its files belong to the workspace across starts and stops.

## Personal computer

A durable logical computer owned by one OpenBot user. Its files and browser sign-ins follow the user across runtime replacements and across the Bots they use.

## Bot execution boundary

The access boundary for Bot shell commands, scripts, and their child processes. It limits filesystem access to authorized workspaces and applies network policy, while keeping browser profiles and management credentials outside that access.

## Browser session

The live browser state a Bot or person can inspect and control, including its open pages and current navigation.

## Page

A browser document that can be opened, inspected, interacted with, or captured as part of computer work.

## Credential

A secret or login record that may be used by a person or Bot within an authorized computer or connection context.

## Recorder

The browser-side capture surface used to connect a person's browser and teach or observe computer work.

## Host access

A controlled path for a desktop or local host to receive work from OpenBot and return its result.

## Computer policy

The rules that constrain network access, browser actions, computer tools, and other effects available to a Bot.

## Snapshot

A saved representation of current computer state that supports inspection, recovery, and user-visible activity.
