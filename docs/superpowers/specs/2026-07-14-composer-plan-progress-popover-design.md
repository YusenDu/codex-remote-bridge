# Composer Plan Progress Popover

## Goal

Replace the large inline Plan card in the conversation with a compact Codex-style progress control above the active thread composer.

## Behavior

- Show the control only when the latest plan has at least one `pending` or `inProgress` step.
- Hide inline `plan` and `plan.live` message cards from the conversation.
- Display a progress ring and the label `Step n of m`, where `n` is the current in-progress step or the next pending step.
- Open the step list on pointer hover or keyboard focus.
- On touch devices, toggle the step list by tapping the control and close it when focus moves outside.
- Mark completed steps with a check, highlight the current step, and mute pending steps.
- Remove the control immediately when every step is completed.
- Do not show completed plans from history after a page reload.

## Component Boundary

Add a `PlanProgressPopover` component beside `ThreadComposer`. It receives normalized plan data and owns only presentation and popover interaction. Plan selection and normalization remain in application state helpers so they can be unit tested independently.

`ThreadConversation` continues to render all non-plan messages and excludes plan messages from the visible stream. The existing plan parsing behavior is moved to a shared helper instead of being duplicated.

## Accessibility

- The trigger is a real button with an accessible progress label.
- The progress ring exposes current and total values through ARIA attributes.
- The popover opens on focus and remains available while focus is inside it.
- Status is communicated by text and icons, not color alone.

## Responsive Layout

- Desktop: center the control directly above the composer; open the popover upward.
- Mobile: keep the control within composer width; cap the popover width to the viewport and allow long step text to wrap.
- The control must not change composer height when the popover opens.

## Tests

- Select the latest incomplete plan and ignore older or fully completed plans.
- Compute current and total step counts correctly.
- Hide the progress control after the final step completes.
- Exclude inline plan cards while preserving non-plan messages.
- Verify hover/focus/tap interaction and accessible labels.
- Check desktop and mobile screenshots for alignment, wrapping, and overlap.

## Out Of Scope

- Persisting a separate plan state outside existing Codex messages.
- Changing the `update_plan` protocol or Desktop Agent transport.
- Deploying the new Web build to the public server.
