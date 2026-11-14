/// <reference types="vite/client" />

interface Window {
  api?: any;
  __treeDone?: boolean;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>;
  export default component;
}