<template>
  <div
    v-if="progress"
    ref="rootRef"
    class="plan-progress-root"
    @pointerenter="openPopover"
    @pointerleave="onPointerLeave"
    @focusin="openPopover"
    @focusout="onFocusOut"
  >
    <div
      v-if="isOpen"
      :id="popoverId"
      class="plan-progress-popover"
      role="status"
      aria-live="polite"
    >
      <p v-if="progress.explanation" class="plan-progress-title">{{ progress.explanation }}</p>
      <ol class="plan-progress-steps">
        <li
          v-for="(step, index) in progress.steps"
          :key="`${progress.messageId}:${index}`"
          class="plan-progress-step"
          :data-status="step.status"
          :aria-current="index === progress.currentStepIndex ? 'step' : undefined"
        >
          <span class="plan-progress-step-icon" :data-status="step.status" aria-hidden="true">
            {{ step.status === 'completed' ? '✓' : index === progress.currentStepIndex ? '' : '·' }}
          </span>
          <span class="plan-progress-step-copy">{{ step.step }}</span>
        </li>
      </ol>
    </div>

    <button
      type="button"
      class="plan-progress-trigger"
      :aria-label="progressLabel"
      :aria-expanded="isOpen"
      :aria-controls="popoverId"
      @pointerdown="rememberPointerType"
      @click="togglePopover"
    >
      <span
        class="plan-progress-ring"
        role="progressbar"
        :aria-label="progressLabel"
        :aria-valuenow="progress.completedStepCount"
        aria-valuemin="0"
        :aria-valuemax="progress.totalSteps"
        :aria-valuetext="progressLabel"
        :style="ringStyle"
      >
        <span class="plan-progress-ring-core" />
      </span>
      <span>{{ progressLabel }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { PlanProgressState } from '../../utils/planProgress'

const props = defineProps<{
  progress: PlanProgressState | null
}>()

const rootRef = ref<HTMLElement | null>(null)
const isOpen = ref(false)
const lastPointerType = ref('')
const popoverId = `${useId()}-plan-progress`

const progressLabel = computed(() => {
  if (!props.progress) return 'Plan progress'
  return `Step ${props.progress.currentStepNumber} of ${props.progress.totalSteps}`
})

const ringStyle = computed(() => {
  const total = props.progress?.totalSteps ?? 0
  const completed = props.progress?.completedStepCount ?? 0
  const angle = total > 0 ? Math.round((completed / total) * 360) : 0
  return { '--plan-progress-angle': `${angle}deg` }
})

function openPopover(event?: Event): void {
  if (event && 'pointerType' in event && event.pointerType === 'touch') return
  isOpen.value = true
}

function closePopover(): void {
  isOpen.value = false
}

function rememberPointerType(event: PointerEvent): void {
  lastPointerType.value = event.pointerType
}

function togglePopover(event: MouseEvent): void {
  if (lastPointerType.value === 'mouse' && event.detail > 0) return
  isOpen.value = !isOpen.value
}

function onPointerLeave(): void {
  if (rootRef.value?.contains(document.activeElement)) return
  closePopover()
}

function onFocusOut(event: FocusEvent): void {
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && rootRef.value?.contains(nextTarget)) return
  closePopover()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!(event.target instanceof Node) || rootRef.value?.contains(event.target)) return
  closePopover()
}

watch(() => props.progress?.messageId, closePopover)

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true))
</script>

<style scoped>
@reference "tailwindcss";

.plan-progress-root {
  @apply relative z-30 mx-auto flex w-full max-w-[min(var(--chat-column-max,72rem),100%)] justify-center;
}

.plan-progress-trigger {
  @apply inline-flex h-9 items-center gap-2 rounded-full border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-400 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700;
}

.plan-progress-ring {
  --plan-progress-angle: 0deg;
  @apply relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full;
  background: conic-gradient(rgb(14 165 233) var(--plan-progress-angle), rgb(203 213 225) 0deg);
}

.plan-progress-ring-core {
  @apply h-2.5 w-2.5 rounded-full bg-white dark:bg-slate-800;
}

.plan-progress-popover {
  position: absolute;
  bottom: calc(100% + 0.5rem);
  left: 50%;
  width: min(22rem, calc(100vw - 2rem));
  max-width: calc(100vw - 2rem);
  transform: translateX(-50%);
  @apply rounded-xl border border-slate-200 bg-white p-2.5 text-left text-slate-800 shadow-xl shadow-slate-950/10 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100;
}

.plan-progress-title {
  @apply m-0 border-b border-slate-200 px-2 pb-2 text-xs font-medium leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-400;
  overflow-wrap: anywhere;
}

.plan-progress-steps {
  @apply m-0 flex list-none flex-col gap-0.5 p-0;
}

.plan-progress-title + .plan-progress-steps {
  @apply mt-1.5;
}

.plan-progress-step {
  @apply flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-sm leading-5 text-slate-500 dark:text-slate-400;
}

.plan-progress-step[data-status='completed'] {
  @apply text-slate-600 dark:text-slate-300;
}

.plan-progress-step[data-status='inProgress'],
.plan-progress-step[aria-current='step'] {
  @apply bg-slate-100 font-medium text-slate-900 dark:bg-slate-700 dark:text-white;
}

.plan-progress-step-icon {
  @apply mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-slate-300 text-[10px] leading-none dark:border-slate-600;
}

.plan-progress-step-icon[data-status='completed'] {
  @apply border-emerald-500 bg-emerald-500 font-bold text-white;
}

.plan-progress-step-icon[data-status='inProgress'] {
  @apply border-sky-500;
  box-shadow: inset 0 0 0 3px rgb(255 255 255), inset 0 0 0 8px rgb(14 165 233);
}

:global(.dark) .plan-progress-step-icon[data-status='inProgress'] {
  box-shadow: inset 0 0 0 3px rgb(51 65 85), inset 0 0 0 8px rgb(14 165 233);
}

.plan-progress-step-copy {
  min-width: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 767px) {
  .plan-progress-root {
    @apply px-1;
  }

  .plan-progress-popover {
    width: min(22rem, calc(100vw - 2rem));
    max-width: calc(100vw - 2rem);
  }
}
</style>
