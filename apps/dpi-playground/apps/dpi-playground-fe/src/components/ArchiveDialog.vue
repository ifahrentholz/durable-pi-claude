<script setup lang="ts">
// Archived sessions of one device (this fork): restore one into the tree, or delete it for good.
import { onMounted, ref } from "vue";
import { Archive, RotateCcw, Trash2, X } from "lucide-vue-next";
import type { ArchivedSession } from "@sdk/api";
import { deviceClient } from "../client/hub";
import { ago, attempt, notify, select, shortPath } from "../client/store";

const props = defineProps<{ deviceId: string }>();
const emit = defineEmits<{ close: [] }>();
const items = ref<ArchivedSession[]>();
const busy = ref<string>();
const confirming = ref<string>();
const client = deviceClient(props.deviceId);

async function load() {
  items.value = (await attempt(() => client.archive())) ?? [];
}
onMounted(load);

const title = (a: ArchivedSession) => a.name || a.firstMessage || "Untitled session";
const size = (bytes: number) => (bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

async function restore(a: ArchivedSession) {
  busy.value = a.dir;
  try {
    const session = await attempt(() => client.restoreArchive(a.dir));
    if (session) {
      notify(`Restored: ${session.name}`);
      select({ deviceId: props.deviceId, sessionId: session.id, agentId: 1 });
      emit("close");
    }
  } finally {
    busy.value = undefined;
  }
}

async function remove(a: ArchivedSession) {
  if (confirming.value !== a.dir) return void (confirming.value = a.dir);
  busy.value = a.dir;
  try {
    if (await attempt(() => client.deleteArchive(a.dir))) {
      notify("Deleted for good.");
      confirming.value = undefined;
      await load();
    }
  } finally {
    busy.value = undefined;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal archive-modal" aria-label="Archived sessions">
      <header>
        <div>
          <span class="eyebrow">ARCHIVE · {{ deviceId }}</span>
          <h2>Archived sessions</h2>
        </div>
        <button class="icon-button" aria-label="Close archive" @click="emit('close')"><X :size="18" /></button>
      </header>
      <p class="hint">
        Archiving stops a session and moves it here. Restore brings it back into the tree with its agents, history and
        names; its agents continue where they stopped. Delete removes it for good.
      </p>
      <p v-if="!items" class="hint">Loading…</p>
      <p v-else-if="!items.length" class="hint">The archive is empty.</p>
      <ul v-else class="archive-list">
        <li v-for="a in items" :key="a.dir">
          <Archive :size="18" class="archive-icon" />
          <div class="archive-text">
            <strong :title="title(a)">{{ title(a) }}</strong>
            <small
              >{{ a.cwd ? shortPath(a.cwd, 40) + " · " : "" }}archived {{ ago(a.archivedAt) }} · {{ size(a.bytes) }}</small
            >
          </div>
          <button class="secondary" :disabled="!!busy" @click="restore(a)"><RotateCcw :size="15" />Restore</button>
          <button class="secondary danger" :disabled="!!busy" @click="remove(a)">
            <Trash2 :size="15" />{{ confirming === a.dir ? "Really delete?" : "Delete" }}
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
