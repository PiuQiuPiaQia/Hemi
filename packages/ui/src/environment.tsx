import { createContext, useContext, type ReactNode, type RefObject } from 'react';
export type UiEnvironment = {
    portal?: HTMLElement | null;
    keyboardRoot?: RefObject<HTMLElement | null>;
    active?: boolean;
};
const Context = createContext<UiEnvironment>({});
/** Supply a theme-scoped portal without coupling primitives to an application. */
export function UiProvider({ children, ...environment }: UiEnvironment & {
    children: ReactNode;
}) {
    return <Context.Provider value={environment}>{children}</Context.Provider>;
}
export function useUiEnvironment() { return useContext(Context); }
