<script setup lang="ts">
import { computed, ref } from "vue";
import { Play, X } from "lucide-vue-next";
import { LANE_HINTS, LANE_LABELS } from "../api";
import type { Model, Ticket } from "../types";

const props = defineProps<{ ticket: Ticket; models: Model[] }>();
const emit = defineEmits<{ close: []; start: [key: string, model: string, lane: string] }>();

// "" means Auto: the backend picks the model from Kev's complexity tier.
const model = ref("");
// Kev's lane is the default; override it if Kev got it wrong.
const lane = ref<string>(props.ticket.classification?.lane ?? "ticket");
const starting = ref(false);
/** Mirrors lanes.ts planFor: needs_clarification sends any code lane through the grill. */
const grill = computed(
  () => lane.value === "feature" || (lane.value !== "question" && props.ticket.classification?.decision === "needs_clarification"),
);

function start() {
  if (starting.value) return;
  starting.value = true;
  emit("start", props.ticket.key, model.value, lane.value);
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal start-modal">
      <header>
        <div>
          <span class="eyebrow">START TICKET</span>
          <h2>{{ ticket.key }}</h2>
        </div>
        <button class="icon-button" aria-label="Close" @click="emit('close')"><X :size="18" /></button>
      </header>
      <p class="start-title">{{ ticket.title }}</p>
      <dl v-if="ticket.classification" class="start-facts">
        <div><dt>Priority</dt><dd>{{ ticket.priority }}</dd></div>
        <div><dt>Kev lane</dt><dd>{{ ticket.classification.lane }}</dd></div>
        <div><dt>Complexity</dt><dd>{{ ticket.classification.tier }}</dd></div>
        <div><dt>Decision</dt><dd>{{ ticket.classification.decision }}</dd></div>
      </dl>
      <label class="start-model">
        <span>Lane</span>
        <select v-model="lane">
          <option v-for="(label, id) in LANE_LABELS" :key="id" :value="id">
            {{ label }}{{ id === ticket.classification?.lane ? " (Kev)" : "" }}
          </option>
        </select>
      </label>
      <p class="hint">{{ LANE_HINTS[lane] }}</p>
      <p v-if="grill" class="start-warn">
        Starts with a grill session: the agent interviews you in the agent chat, one question at a time, until you
        confirm the scope and acceptance criteria. Only then does it implement.
      </p>
      <label class="start-model">
        <span>Model</span>
        <select v-model="model">
          <option value="">Auto - from Kev's tier</option>
          <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
      </label>
      <p class="hint">Auto = Sonnet for simple/moderate, Opus for complex. Override if you like.</p>
      <div class="start-actions">
        <button class="secondary" @click="emit('close')">Cancel</button>
        <button class="primary small" :disabled="starting || !ticket.repo" @click="start">
          <Play :size="16" />{{ starting ? "Starting…" : "Start agent" }}
        </button>
      </div>
      <p v-if="!ticket.repo" class="start-warn">No repo mapping for project {{ ticket.project }}.</p>
    </section>
  </div>
</template>
