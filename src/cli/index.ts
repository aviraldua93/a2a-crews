#!/usr/bin/env bun

const command = process.argv[2];

switch (command) {
  case 'plan':
    // TODO: import and run plan
    console.log('🔍 crews plan — coming soon');
    break;
  case 'apply':
    console.log('📋 crews apply — coming soon');
    break;
  case 'launch':
    console.log('🚀 crews launch — coming soon');
    break;
  case 'watch':
    console.log('👀 crews watch — coming soon');
    break;
  case 'stop':
    console.log('🛑 crews stop — coming soon');
    break;
  default:
    printHelp();
}

function printHelp() {
  console.log(`
  a2a-crews — Turn one command into a team of AI agents

  Usage: crews <command> [options]

  Commands:
    plan <scenario>     Assess feasibility and compose a team
    apply               Review plan, approve, create team
    launch [name]       Spawn agents and orchestrate execution
    watch [name]        Stream live status from agents
    stop [name]         Cancel all tasks and stop agents

  Examples:
    crews plan "Build a REST API with auth and tests"
    crews apply
    crews launch my-api
    crews watch my-api

  Built on Google's A2A protocol. https://a2a-protocol.org
  `);
}
