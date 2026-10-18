<script setup lang="ts">
// Custom harness extensions for the selected agent: a switch per extension, and for system-prompts a checklist of
// built-in prompts. A change edits the agent's stored selection, so the next request runs with it.
import { ref, shallowRef, watch } from "vue";
import { Puzzle } from "lucide-vue-next";
import type { AgentExtensions } from "@sdk/api";
import { agentHandle, agentState, attempt, online, refreshDetail } from "../client/store";
import { editRules, loadRules } from "../client/approvals";

// Approval rules (this fork): commands that run without asking, for the whole session.
const rules = ref<string[]>();
const newRule = ref("");
watch([agentHandle, online], async () => (rules.value = agentHandle.value && online.value ? await loadRules() : undefined), { immediate: true });
async function addRule() {
  if (!newRule.value.trim()) return;
  rules.value = (await editRules({ add: newRule.value.trim() })) ?? rules.value;
  newRule.value = "";
}
async function removeRule(rule: string) {
  rules.value = (await editRules({ remove: rule })) ?? rules.value;
}

const data = shallowRef<AgentExtensions>();
const busy = ref(false);

async function load() {
  const handle = agentHandle.value;
  if (!handle || !online.value) return void (data.value = undefined);
  data.value = (await handle.extensions().catch(() => undefined)) ?? data.value;
}
// Reload on a new selection, and when the agent's stored extension selection changes from any client.
watch([agentHandle, online, () => JSON.stringify(agentState.value.agent.extensions ?? null)], load, { immediate: true });

async function set(patch: { name: string; enabled: boolean } | { prompt: string; enabled: boolean }) {
  const handle = agentHandle.value;
  if (!handle || busy.value) return;
  busy.value = true;
  try {
    const next = await attempt(() => handle.setExtension(patch));
    if (next) data.value = next;
    void refreshDetail();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="extensions-panel">
    <div class="panel-heading">
      <h2>Extensions</h2>
      <Puzzle :size="18" />
    </div>
    <p class="hint">
      Custom harness capabilities for this agent. Turn one on and the next request uses it. The choice is stored
      with the agent, so it survives restarts.
    </p>
    <p v-if="!data" class="task-empty">Loading extensions…</p>
    <article
      v-for="ext in data?.extensions ?? []"
      :key="ext.name"
      class="ext-card"
      :class="{ on: ext.enabled }"
      :data-extension="ext.name"
    >
      <div class="ext-head">
        <div>
          <strong>{{ ext.title }}</strong>
          <code>{{ ext.name }}</code>
        </div>
        <button
          class="switch"
          role="switch"
          :class="{ on: ext.enabled }"
          :aria-checked="ext.enabled"
          :aria-label="ext.title"
          :disabled="busy"
          @click="set({ name: ext.name, enabled: !ext.enabled })"
        >
          <span />
        </button>
      </div>
      <p>{{ ext.description }}</p>
      <div v-if="ext.name === 'approvals'" class="ext-rules" :class="{ off: !ext.enabled }">
        <strong>Allowed without asking (this session)</strong>
        <ul class="rules-list">
          <li v-for="r in rules ?? []" :key="r">
            <code>{{ r }}</code><button class="secondary danger" :aria-label="`Remove ${r}`" @click="removeRule(r)">✕</button>
          </li>
        </ul>
        <form class="rules-add" @submit.prevent="addRule">
          <input v-model="newRule" placeholder="Bash(mvn test:*)  or  edit" aria-label="New rule" />
          <button class="secondary" type="submit">Add</button>
        </form>
      </div>
      <ul v-if="ext.prompts" class="ext-prompts" :class="{ off: !ext.enabled }">
        <li v-for="p in ext.prompts" :key="p.id">
          <label>
            <input
              type="checkbox"
              :checked="p.enabled"
              :disabled="busy"
              @change="set({ prompt: p.id, enabled: ($event.target as HTMLInputElement).checked })"
            />
            <code>{{ p.id }}</code>
          </label>
          <span>{{ p.description }}</span>
          <details>
            <summary>View prompt</summary>
            <pre>{{ p.text }}</pre>
          </details>
        </li>
      </ul>
    </article>
  </div>
</template>
