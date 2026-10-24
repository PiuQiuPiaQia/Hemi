# @hemi/ui

Hemi's shared React DOM interface primitives. Desktop and Capacitor applications use the same components; applications supply their theme, density and platform services.

```tsx
import {UiProvider, Button, Menu, Sheet} from '@hemi/ui';
import '@hemi/ui/tokens.css';

<UiProvider portal={themeScopedPortal}>
  <Button onClick={open}>Open</Button>
</UiProvider>
```

Exports include `Button`, `Dialog` and its parts, `Menu` and its parts, `InfoPopover`, `ScrollArea`, `Sheet`, `IconButton`, `useDialogFocus`, `UiProvider`, and `cn`.

`UiProvider` accepts an optional portal container, keyboard root and active state. A conversation instance supplies these automatically. Application menus may use the default environment. The primitives never access Electron, Capacitor, IPC or a conversation client.

The tokens stylesheet is the canonical Hemi token definition. Components preserve the existing Hemi class names; the consuming application's surface styles set desktop/touch density and shell layout. Conversation consumers also import `@hemi/conversation-flow/styles.css` for the package's scoped component styles. Tailwind applications must include this package in class discovery.

React and React DOM 19 are peer dependencies. Run `npm ci` at the repository root and `npm run build:sdk` to build the primitives before their conversation consumers. The package builds ESM and TypeScript declarations and can be packed independently with `npm pack --workspace @hemi/ui`.

## Shared styles and selection surfaces

`@hemi/ui/styles.css` provides the common control, menu, info-popover and Dialog styles. `@hemi/ui/styles/touch.css` provides the touch IconButton, Sheet, selection-row and form styles. Desktop applications opt into `@hemi/ui/styles/native.css` for keyboard focus/selection/drag behavior. Individual styles remain available through `@hemi/ui/styles/*.css` when an application must preserve its existing cascade order. All are shipped in the package; no application source paths are needed.

Touch styles use the host's `--m-*`, `--s*`, `--text-*` and surface-radius variables. Desktop styles use `tokens.css`. The host controls its theme, density and safe-area/keyboard container.

`useControlDisclosure` supports standalone or host-controlled open state. `SelectionSurface` selects a desktop Menu or touch Sheet and restores focus to the trigger. Put the `UiProvider` portal outside any background made `inert` while a Sheet is open, within the same theme and keyboard-resized container. This lets a toolbar control remain mounted while its surface is interactive.

## Status notices and transient messages

`StatusNotice` shares banner/inline/note live regions, content, optional icon and action slots. Use `layout="desktop"` or `layout="touch"`; wording, connection delay, operation state and retry callbacks remain host responsibilities. Desktop banner styles ship in `styles/status.css` (also included by `styles.css`), touch variants in `styles/touch.css`.

`Toast` is presentational and leaves portal placement to the host. `useTransientMessage<T>(duration = 2600)` returns the current message and a stable show/clear function; repeating the same value restarts the interval, replacements cannot be removed by an old timer, and unmount clears the timer. `TimedToast` supports an expiry callback for a specific operation receipt. Key it by receipt identity so unmount cancels acknowledgement of a replaced operation.

## Empty, loading and failed surfaces

`StateView`, `EmptyState`, `LoadingState` and `ErrorState` share illustrations, headings, descriptions and controlled action buttons. The host supplies existing classes, heading level, copy and action callbacks so a welcome page, inline failure and full-page recovery keep their presentation. Loading announces a status; errors announce an alert unless the host supplies its existing role. Empty views do not announce automatically. These components never infer emptiness from connectivity or clear cached data.

`ErrorBoundary` catches render failures within its children. Supply `fallback` or a `(error, reset) => ReactNode` fallback, optional `onError(error, info)` diagnostics and `onReset`. A manual reset remounts the failed content; changing `resetKey` clears a failure when the environment/document changes. Hosts retain logging, recovery navigation and retry policy. Async operation errors remain controlled state, not render-boundary errors.
