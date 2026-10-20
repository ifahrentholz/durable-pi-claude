<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowUpRight, ChevronDown, GitBranch, GitCommitHorizontal, GitMerge, LoaderCircle } from "lucide-vue-next";
import { LANE_LABELS, STAGE_LABELS, STAGE_STEPS, api, needsDecision } from "../api";
import type { Ticket } from "../types";

const props = defineProps<{ ticket: Ticket }>();
const emit = defineEmits<{ open: [conversationId: number] }>();
type Review = { ahead: number; head: string | null; log: string; diffStat: string; diff: string };

const open = ref(false);
const review = ref<Review>();
const loading = ref(false);
/** The lane's stepper, fixed when the ticket started; older tickets fall back to the default chain. */
const steps = computed(() => props.ticket.plan?.steps ?? STAGE_STEPS);
const reached = computed(() => {
  // Before the agent reports a stage (discovered, starting) the stepper sits on its first step.
  if (["discovered", "starting"].includes(props.ticket.stage)) return 0;
  const i = steps.value.indexOf(props.ticket.stage);
  if (i >= 0) return i;
  // Blocked: stay on the last step the ticket reached.
  const last = [...props.ticket.timeline].reverse().find((e) => steps.value.includes(e.stage));
  return last ? steps.value.indexOf(last.stage) : 0;
});
const merged = computed(() => ["merged", "answered"].includes(props.ticket.stage));
const reviewLabel = computed(() => {
  const r = props.ticket.review;
  if (!r) return "";
  if (r.verdict === "pending") return `round ${r.round} running`;
  if (r.verdict === "pass_with_risks") return `round ${r.round}: passed with ${r.risks?.length ?? 0} open risk${r.risks?.length === 1 ? "" : "s"}`;
  return `round ${r.round}: ${r.verdict === "pass" ? "passed" : "changes requested"}`;
});
const time = (t: number | string) => new Date(t).toLocaleTimeString();
const diffLines = computed(() =>
  (review.value?.diff ?? "").split("\n").map((text) => ({
    text,
    kind: text.startsWith("+++") || text.startsWith("---")
      ? "file"
      : text.startsWith("+")
        ? "add"
        : text.startsWith("-")
          ? "del"
          : text.startsWith("@@")
            ? "hunk"
            : "",
  })),
);

async function loadReview() {
  loading.value = true;
  try {
    review.value = await api<Review>(`/tickets/${props.ticket.key}/review`);
  } finally {
    loading.value = false;
  }
}

watch(open, (now) => {
  if (now && !review.value) void loadReview();
});
</script>

<template>
  <section class="incident-card" :class="ticket.stage">
    <button class="incident-top" :aria-expanded="open" @click="open = !open">
      <GitMerge :size="18" />
      <strong>{{ ticket.key }}</strong>
      <span v-if="ticket.lane" class="lane-chip">{{ LANE_LABELS[ticket.lane] }}</span>
      <span class="incident-title">{{ ticket.title }}</span>
      <span class="incident-status"><i />{{ needsDecision(ticket) ? "Decision needed" : STAGE_LABELS[ticket.stage] }}</span>
      <ChevronDown :size="18" :class="{ flipped: open }" />
    </button>
    <ol class="incident-steps">
      <li
        v-for="(step, i) in steps"
        :key="step"
        :class="{ done: i < reached || (merged && i === reached), current: i === reached && !merged }"
      >
        <i />{{ STAGE_LABELS[step] }}
      </li>
    </ol>
    <p class="incident-summary" :class="{ setup: ticket.stage === 'starting' || ticket.review?.verdict === 'pending' }">
      <LoaderCircle
        v-if="ticket.stage === 'starting' || (ticket.stage === 'review' && ticket.review?.verdict === 'pending')"
        :size="15"
        class="spinning"
      />{{ ticket.summary }}
    </p>
    <div v-if="needsDecision(ticket) && ticket.review?.risks?.length" class="risk-box">
      <strong>⚠ Decision needed: open risks after review</strong>
      <ul>
        <li v-for="(r, i) in ticket.review.risks" :key="i"><code>{{ r.location }}</code> — {{ r.statement }}</li>
      </ul>
      <p class="hint">
        The MR is a draft. Ask the agent below for a fix, or accept the risk and mark the MR ready in GitLab.
      </p>
    </div>
    <div v-if="open" class="incident-body">
      <dl class="incident-facts">
        <div><dt>Priority</dt><dd>{{ ticket.priority }}</dd></div>
        <div v-if="ticket.classification">
          <dt>Kev</dt>
          <dd>{{ ticket.classification.tier }} / {{ ticket.classification.lane }} · {{ ticket.classification.decision }}</dd>
        </div>
        <div><dt>Discovered</dt><dd>{{ time(ticket.discoveredAt) }}</dd></div>
        <div v-if="ticket.repo"><dt>Branch</dt><dd><GitBranch :size="16" />{{ ticket.repo.branch }}</dd></div>
        <div v-if="ticket.review">
          <dt>Review</dt>
          <dd>
            {{ reviewLabel }}
            <button
              v-if="ticket.review.reviewerConversationId"
              class="link-button"
              @click="emit('open', ticket.review.reviewerConversationId)"
            >
              Open review session<ArrowUpRight :size="14" />
            </button>
          </dd>
        </div>
        <div v-if="ticket.report.mrUrl"><dt>MR</dt><dd><a :href="ticket.report.mrUrl" target="_blank" rel="noreferrer">{{ ticket.report.mrUrl }}</a></dd></div>
      </dl>
      <div v-if="ticket.scope" class="scope-box">
        <strong>Confirmed scope</strong>
        <p>{{ ticket.scope.summary }}</p>
        <ol>
          <li v-for="(ac, i) in ticket.scope.acceptance" :key="i"><b>AC-{{ i + 1 }}</b> {{ ac }}</li>
        </ol>
      </div>
      <pre v-if="ticket.review && ticket.review.verdict !== 'pending' && ticket.review.findings" class="review-log">{{
        ticket.review.findings
      }}</pre>
      <div class="incident-actions">
        <button class="secondary" :disabled="loading || !ticket.repo" @click="loadReview">
          <GitCommitHorizontal :size="18" />{{ review ? "Refresh diff" : "View diff" }}
        </button>
        <span v-if="review" class="hint">{{ review.ahead }} commit{{ review.ahead === 1 ? "" : "s" }} ahead</span>
      </div>
      <template v-if="review">
        <pre v-if="review.log" class="review-log">{{ review.log }}</pre>
        <pre v-if="review.diff" class="diff"><span v-for="(line, i) in diffLines" :key="i" :class="line.kind">{{ line.text }}
</span></pre>
        <p v-else class="hint">No changes on the branch yet.</p>
      </template>
    </div>
  </section>
</template>
