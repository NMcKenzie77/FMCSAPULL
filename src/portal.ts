import express, { type Express } from 'express';

const proto = express.application as unknown as {
  get: Function;
  __portalRoutePatch?: boolean;
};

if (!proto.__portalRoutePatch) {
  proto.__portalRoutePatch = true;

  const originalGet = proto.get;

  proto.get = function patchedGet(this: Express, path: unknown, ...handlers: unknown[]) {
    const isAgentPath = path === '/agent' || path === '/agent/login';
    const handlerText = handlers.map((handler) => String(handler)).join('\n');

    if (isAgentPath && handlerText.includes('agentPageHtml')) return this;

    return originalGet.call(this, path, ...handlers);
  };
}

await import('./u2.js');

export const portalVersion = '5';
