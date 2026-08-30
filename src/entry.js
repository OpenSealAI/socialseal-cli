#!/usr/bin/env node
import { Command } from 'commander';

// The conversational agent belongs to the web application. Keep the legacy
// implementation module available internally while preventing it from being
// registered or advertised by the installed CLI entrypoint.
const originalCommand = Command.prototype.command;
const originalAddHelpText = Command.prototype.addHelpText;

Command.prototype.command = function (nameAndArgs, actionOptsOrExecDesc, execOpts) {
  const commandName = String(nameAndArgs ?? '')
    .trim()
    .split(/[ <[]/, 1)[0];

  if (commandName === 'agent') {
    return new Command('agent');
  }

  return originalCommand.call(this, nameAndArgs, actionOptsOrExecDesc, execOpts);
};

Command.prototype.addHelpText = function (position, text) {
  const filteredText =
    typeof text === 'string'
      ? text.replace(/^\s*socialseal agent run --message "ping"\s*\n?/m, '')
      : text;
  return originalAddHelpText.call(this, position, filteredText);
};

await import('./index.js');
