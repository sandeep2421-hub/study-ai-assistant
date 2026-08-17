const { contextBridge, ipcRenderer } = require('electron');

/** All channels that MUST be individually removable (cleanup in useEffect deps) */
const REMOVABLE_CHANNELS = [
  'toggle-mode',
  'capture-screenshot',
  'clipboard-text',
  'send-to-ai',
  'auto-type-code',
  'ghost-mode-toggled',
  'scroll-down',
  'scroll-up',
  'clear-all',
  'code-copied',
  'refine-code',
  'typing-started',
  'typing-failed-empty',
  'auto-type-code-trigger',
  'quit'
];

/** All channels that can be safely invoked from the renderer */
const INVOKABLE_CHANNELS = [
  'take-screenshot',
  'auto-type-code',
  'set-ghost-mode',
  'set-last-ai-response',
  'set-last-refined-response',
  'log-debug',
  'self-destruct'
];

contextBridge.exposeInMainWorld('electronAPI', {
  // subscribe to a main-process event
  on: (channel, callback) => {
    if (REMOVABLE_CHANNELS.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },

  // remove all listeners for ONE specific channel (not every channel)
  off: (channel) => {
    if (REMOVABLE_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },

  // invoke a main-process handler and await its response
  invoke: (channel, data) => {
    if (INVOKABLE_CHANNELS.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
  }
});
