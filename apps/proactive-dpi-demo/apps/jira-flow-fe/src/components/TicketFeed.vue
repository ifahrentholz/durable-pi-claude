<script setup lang="ts">
import { computed } from "vue";
import { ArrowUpRight, GitMerge, Inbox, LoaderCircle, Play } from "lucide-vue-next";
import { PRIORITY_RANK, chipClass, feedChip } from "../api";
import type { Stats, Ticket } from "../types";

const props = defineProps<{
  tickets: Ticket[];
  stats?: Stats;
  connected: boolean;
  selected: number;
}>();
const emit = defineEmits<{ open: [id: number]; start: [key: string] }>();

const sorted = computed(() =>
  [...props.tickets].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.discoveredAt - a.discoveredAt,
  ),
);
/** Tickets with an agent (started), pinned above the feed until they merge or are answered. Includes setup + blocked. */
const running = computed(() =>
  sorted.value.filter((t) => t.conversationId && !["merged", "answered"].includes(t.stage)),
);
const time = (t: number | string) => new Date(t).toLocaleTimeString();
const prioClass = (p: string) => p.toLowerCase();

function onRow(t: Ticket) {
  if (t.conversationId) emit("open", t.conversationId);
  else if (t.stage === "discovered" && t.repo) emit("start", t.key);
}
</script>

<template>
  <section class="stream-panel">
    <header class="stream-header">
      <div class="stream-title">
        <Inbox :size="20" />
        <div>
          <h2>Ticket feed</h2>
          <small>Jira · label = ready-for-agent</small>
        </div>
      </div>
      <span v-if="!connected" class="stream-live"><i />Reconnecting</span>
    </header>
    <div class="stream-stats">
      <div class="normal"><span>{{ stats?.ready ?? 0 }}</span><small>ready</small></div>
      <div class="suspicious"><span>{{ stats?.needsClarification ?? 0 }}</span><small>needs clar.</small></div>
      <div><span>{{ stats?.inProgress ?? 0 }}</span><small>in progress</small></div>
      <div class="incident"><span>{{ stats?.waiting ?? 0 }}</span><small>waiting you</small></div>
      <div><span>{{ stats?.done ?? 0 }}</span><small>done</small></div>
      <div><span>{{ stats?.blocked ?? 0 }}</span><small>blocked</small></div>
    </div>

    <TransitionGroup name="toast">
      <div
        v-for="t in running"
        :key="t.key"
        class="stream-incident"
        :class="[chipClass(t), { current: t.conversationId === selected }]"
      >
        <button class="stream-incident-open" @click="emit('open', t.conversationId!)">
          <LoaderCircle v-if="t.stage === 'starting'" :size="18" class="spinning" /><GitMerge v-else :size="18" /><strong>{{ t.key }}</strong
          ><span class="stream-incident-title">{{ t.title }}</span
          ><span class="incident-status"><i />{{ t.stage === 'starting' ? 'Setting up…' : feedChip(t) }}</span
          ><span class="open-agent">Open agent<ArrowUpRight :size="16" /></span>
        </button>
      </div>
    </TransitionGroup>

    <div class="log-head feed-head">
      <span>Gefunden</span><span>Wichtigkeit</span><span>Projekt</span><span>Ticket-Headline</span><span>Kev-Decision</span>
    </div>
    <div class="log-scroll">
      <div v-if="!tickets.length" class="empty-panel">
        <Inbox :size="28" /><strong>Waiting for tickets</strong
        ><span>Label a Jira ticket “ready-for-agent”.</span>
      </div>
      <div
        v-for="t in sorted"
        :key="t.key"
        class="log-row feed-row"
        :class="{ startable: t.stage === 'discovered' && t.repo, current: t.conversationId === selected }"
        @click="onRow(t)"
      >
        <span class="log-time">{{ time(t.discoveredAt) }}</span>
        <span class="prio" :class="prioClass(t.priority)">{{ t.priority }}</span>
        <span class="log-service">{{ t.project }}</span>
        <span class="log-event"><b>{{ t.key }}</b> — {{ t.title }}</span>
        <span class="jev-chip" :class="chipClass(t)">
          <Play v-if="t.stage === 'discovered' && t.repo" :size="12" />{{ feedChip(t) }}
        </span>
      </div>
    </div>
  </section>
</template>
