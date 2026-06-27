import express, { type Express } from 'express';
import './u2.js';

const proto = express.application as unknown as { get: Function; __portalRoutePatch?: boolean };

if (!proto.__portalRoutePatch) {
  proto.__portalRoutePatch = true;
  const originalGet = proto.get;

  proto.get = function patchedGet(this: Express, path: unknown, ...handlers: unknown[]) {
    if (path === '/agent' || path === '/agent/login') return this;
    return originalGet.call(this, path, ...handlers);
  };
}

export const portalVersion = '3';
