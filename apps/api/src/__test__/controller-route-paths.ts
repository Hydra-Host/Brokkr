import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';

type ClassRef = abstract new (...args: never[]) => unknown;

function isClassRef(value: unknown): value is ClassRef {
  return typeof value === 'function';
}

function toPathList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function joinPath(prefix: string, path: string): string {
  const segments = [prefix, path].map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${segments.join('/')}`;
}

function methodHandlers(controller: ClassRef): unknown[] {
  const handlers: unknown[] = [];
  const seen = new Set<string>();
  let proto: unknown = controller.prototype;
  while (typeof proto === 'object' && proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || seen.has(name)) continue;
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (descriptor && typeof descriptor.value === 'function') handlers.push(descriptor.value);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return handlers;
}

export function controllerRoutePaths(controller: ClassRef): string[] {
  const prefixes = toPathList(Reflect.getMetadata(PATH_METADATA, controller));
  const controllerPrefixes = prefixes.length > 0 ? prefixes : [''];
  const paths: string[] = [];
  for (const handler of methodHandlers(controller)) {
    if (typeof handler !== 'function') continue;
    for (const methodPath of toPathList(Reflect.getMetadata(PATH_METADATA, handler))) {
      for (const prefix of controllerPrefixes) paths.push(joinPath(prefix, methodPath));
    }
  }
  return paths;
}

function resolveModuleEntry(entry: unknown): { moduleRef?: ClassRef; controllers: unknown[]; imports: unknown[] } {
  if (isClassRef(entry)) return { moduleRef: entry, controllers: [], imports: [] };
  if (typeof entry !== 'object' || entry === null) return { controllers: [], imports: [] };
  if ('forwardRef' in entry && typeof entry.forwardRef === 'function') {
    return resolveModuleEntry(entry.forwardRef());
  }
  const moduleRef = 'module' in entry && isClassRef(entry.module) ? entry.module : undefined;
  const controllers = 'controllers' in entry && Array.isArray(entry.controllers) ? entry.controllers : [];
  const imports = 'imports' in entry && Array.isArray(entry.imports) ? entry.imports : [];
  return { moduleRef, controllers, imports };
}

export function collectModuleControllers(root: ClassRef): ClassRef[] {
  const controllers = new Set<ClassRef>();
  const visitedModules = new Set<ClassRef>();
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const { moduleRef, controllers: dynamicControllers, imports: dynamicImports } = resolveModuleEntry(queue.shift());
    for (const controller of dynamicControllers) if (isClassRef(controller)) controllers.add(controller);
    queue.push(...dynamicImports);
    if (!moduleRef || visitedModules.has(moduleRef)) continue;
    visitedModules.add(moduleRef);
    const staticControllers: unknown = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, moduleRef);
    if (Array.isArray(staticControllers)) {
      for (const controller of staticControllers) if (isClassRef(controller)) controllers.add(controller);
    }
    const staticImports: unknown = Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleRef);
    if (Array.isArray(staticImports)) for (const entry of staticImports) queue.push(entry);
  }
  return [...controllers];
}
