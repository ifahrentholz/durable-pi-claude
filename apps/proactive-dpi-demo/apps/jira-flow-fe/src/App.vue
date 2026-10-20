<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Info } from "lucide-vue-next";
import AgentChat from "./components/AgentChat.vue";
import TicketFeed from "./components/TicketFeed.vue";
import StartModal from "./components/StartModal.vue";
import { api } from "./api";
import type { Config, Stats, Ticket } from "./types";

const config = ref<Config>();
const tickets = ref<Ticket[]>([]);
const stats = ref<Stats>();
const streamConnected = ref(false);
const conversationId = ref(0);
const error = ref("");
const startTarget = ref<Ticket>();
const lastPollAt = ref(Date.now());
const now = ref(Date.now());
let stream: EventSource | undefined;
let clock: ReturnType<typeof setInterval>;

// A ring that fills over the poll interval and resets on each poll, so you can see when the next one is due.
const RING = 2 * Math.PI * 8;
const pollFraction = computed(() => {
  const span = (config.value?.pollIntervalSec ?? 30) * 1000;
  return Math.min(1, Math.max(0, (now.value - lastPollAt.value) / span));
});
const ringOffset = computed(() => RING * (1 - pollFraction.value));
const secsToPoll = computed(() => {
  const span = (config.value?.pollIntervalSec ?? 30) * 1000;
  return Math.max(0, Math.ceil((span - (now.value - lastPollAt.value)) / 1000));
});

function upsertTickets(list: Ticket[]) {
  for (const ticket of list) {
    const i = tickets.value.findIndex((t) => t.key === ticket.key);
    if (i < 0) tickets.value.unshift(ticket);
    else if (ticket.updatedAt >= tickets.value[i].updatedAt) tickets.value[i] = ticket;
  }
}

function selectConversation(id: number) {
  conversationId.value = id;
}

function connectStream() {
  stream?.close();
  stream = new EventSource("/api/stream");
  stream.addEventListener("init", (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    tickets.value = data.tickets;
    stats.value = data.stats;
    if (data.polledAt) lastPollAt.value = data.polledAt;
    streamConnected.value = true;
    if (!conversationId.value) selectConversation(config.value!.rootConversationId);
  });
  stream.addEventListener("ticket", (e) => upsertTickets([JSON.parse((e as MessageEvent).data)]));
  stream.addEventListener("status", (e) => {
    stats.value = JSON.parse((e as MessageEvent).data).stats;
  });
  stream.addEventListener("polled", (e) => {
    lastPollAt.value = JSON.parse((e as MessageEvent).data).at ?? Date.now();
  });
  stream.onerror = () => (streamConnected.value = false);
}

function openStart(key: string) {
  startTarget.value = tickets.value.find((t) => t.key === key);
}

async function doStart(key: string, model: string, lane: string) {
  error.value = "";
  // Close the modal at once; the backend returns fast and the heavy work runs in the background.
  startTarget.value = undefined;
  try {
    const { conversationId: cid } = await api<{ conversationId: number }>(
      `/tickets/${key}/start`,
      { ...(model ? { model } : {}), ...(lane ? { lane } : {}) },
    );
    if (cid) selectConversation(cid);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function keydown(e: KeyboardEvent) {
  if (e.key === "Escape") startTarget.value = undefined;
}

onMounted(async () => {
  document.addEventListener("keydown", keydown);
  clock = setInterval(() => (now.value = Date.now()), 250);
  try {
    config.value = await api<Config>("/config");
    connectStream();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
onBeforeUnmount(() => {
  stream?.close();
  clearInterval(clock);
  document.removeEventListener("keydown", keydown);
});
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <img class="brandmark" src="/icons/durable-pi.svg" alt="Durable Pi" /><strong>Jira Flow Agent</strong
        ><span class="brand-separator">/</span
        ><span class="brand-scope">{{ config?.projects.join(", ") || "no projects mapped" }}</span>
      </div>
      <div class="top-actions">
        <span class="watch-pill" :class="{ live: streamConnected }" :title="`Next poll in ${secsToPoll}s`"
          ><svg class="poll-ring" width="18" height="18" viewBox="0 0 20 20" :style="{ transform: 'rotate(-90deg)' }"><circle class="poll-ring-track" cx="10" cy="10" r="8" fill="none" /><circle class="poll-ring-fill" cx="10" cy="10" r="8" fill="none" :stroke-dasharray="RING" :stroke-dashoffset="ringOffset" /></svg>Polling{{ config ? ` · ${config.pollIntervalSec}s` : "" }}</span
        ><span class="revision-pill" title="Judge">Kev <b>{{ config?.judge ?? "…" }}</b></span
        ><span class="revision-pill" title="Max parallel agents">max <b>{{ config?.maxConcurrent ?? "…" }}</b></span>
        <span class="version">v{{ config?.version ?? "0.1.0" }}</span>
      </div>
    </header>
    <div v-if="error" class="error-banner" role="alert">
      <Info :size="18" /><span>{{ error }}</span
      ><button class="icon-button" aria-label="Dismiss error" @click="error = ''">×</button>
    </div>
    <main class="workspace">
      <AgentChat
        v-if="config && conversationId"
        :config="config"
        :conversation-id="conversationId"
        :tickets="tickets"
        @select="selectConversation"
        @tickets="upsertTickets"
      />
      <section v-else class="chat-panel" />
      <TicketFeed
        :tickets="tickets"
        :stats="stats"
        :connected="streamConnected"
        :selected="conversationId"
        @open="selectConversation"
        @start="openStart"
      />
    </main>
    <StartModal
      v-if="startTarget && config"
      :ticket="startTarget"
      :models="config.models"
      @close="startTarget = undefined"
      @start="doStart"
    />
  </div>
</template>
