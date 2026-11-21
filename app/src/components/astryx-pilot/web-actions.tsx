import { Button } from "@astryxdesign/core/Button";
import { IconBolt, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";

function NewConversationLink({ href: _href, ...props }: ComponentProps<"a">) {
  return <Link {...props} to="/channel/new" />;
}

function BotsLink({ href: _href, ...props }: ComponentProps<"a">) {
  return <Link {...props} to="/bots" />;
}

export function AstryxNewConversation() {
  return (
    <Button
      as={NewConversationLink}
      href="/channel/new"
      icon={<IconPlus aria-hidden size={18} />}
      label="New conversation"
      variant="primary"
    />
  );
}

export function AstryxBrowseBots() {
  return (
    <Button
      as={BotsLink}
      href="/bots"
      icon={<IconBolt aria-hidden size={18} />}
      label="Browse Bots"
      variant="secondary"
    />
  );
}
