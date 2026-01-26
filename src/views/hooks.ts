import { createContext, useContext } from "react";
import GiteeSyncPlugin from "src/main";

export const PluginContext = createContext<GiteeSyncPlugin | undefined>(
  undefined,
);

export const usePlugin = (): GiteeSyncPlugin | undefined => {
  return useContext(PluginContext);
};
