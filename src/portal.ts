import express, { type Express } from 'express';

const proto = express.application as unknown as {
  get: Function;
  listen: Function;
  __portalRoutePatch?: boolean;
};

if (!proto.__portalRoutePatch) {
  proto.__portalRoutePatch = true;

  const originalGet = proto.get;
  const originalListen = proto.listen;
  let skipBasicAgentRoutes = true;

  proto.get = function patchedGet(this: Express, path: unknown, ...handlers: unknown[]) {
    if (skipBasicAgentRoutes && (path === '/agent' || path === '/agent/login')) return this;
    return originalGet.call(this, path, ...handlers);
  };

  proto.listen = function patchedListen(this: Express, ...args: unknown[]) {
    skipBasicAgentRoutes = false;
    return originalListen.apply(this, args);
  };
}

await import('./u2.js');

export const portalVersion = '4';
