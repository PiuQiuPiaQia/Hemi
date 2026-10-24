// Compile the workspace and its native error boundary in one module so class identity is preserved.
export {createBotWorkspace} from '../src/bot/workspace-client';
export {BotCommandRejected} from '../src/bot/conversation-transport';
