import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier,context,next){
  if(specifier==='pg') return {url:new URL('./pg-memory.js',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
} });
