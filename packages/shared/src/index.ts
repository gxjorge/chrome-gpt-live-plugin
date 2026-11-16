import { z } from "zod";

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Only HTTP and HTTPS URLs are allowed.");

// Pages may also be local PDFs opened in Chrome's viewer; navigation stays HTTP(S)-only.
const pageUrlSchema = z
  .string()
  .url()
  .refine((value) => /^(?:https?|file):\/\//i.test(value), "Only HTTP, HTTPS, and local file URLs are allowed.");

export const DEFAULT_LIVE_DEPLOYMENT = "gpt-live-1";
export const DEFAULT_ASTRA_DEPLOYMENT = "gpt-6-astra";

export const foundryProjectEndpointSchema = z.string().trim().url().pipe(z.string().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && /^[a-z0-9-]+\.services\.ai\.azure\.com$/i.test(url.hostname) &&
    /^\/api\/projects\/[^/]+\/?$/.test(url.pathname) &&
    !url.username && !url.password && !url.port && !url.search && !url.hash;
}, "Use an HTTPS Foundry project URL: https://<resource>.services.ai.azure.com/api/projects/<project>.")
  .transform((value) => value.replace(/\/$/, "")));

export const azureOpenAIEndpointSchema = z.string().trim().url().pipe(z.string().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && /^[a-z0-9-]+\.openai\.azure\.com$/i.test(url.hostname) &&
    url.pathname === "/" && !url.username && !url.password && !url.port && !url.search && !url.hash;
}, "Use an HTTPS Azure OpenAI resource URL: https://<resource>.openai.azure.com.")
  .transform((value) => value.replace(/\/$/, "")));

const deploymentSchema = z.string().trim().min(1, "Enter a deployment name.").max(128);

export const foundryConfigurationSchema = z.object({
  projectEndpoint: foundryProjectEndpointSchema.optional(),
  liveDeployment: deploymentSchema.optional(),
  astraDeployment: deploymentSchema.optional(),
  decisionDeployment: deploymentSchema.optional(),
  browserControl: z.enum(["astra", "md1-first"]).optional(),
}).strict();

export type FoundryConfiguration = z.infer<typeof foundryConfigurationSchema>;

export const resolvedFoundryConfigurationSchema = z.object({
  values: foundryConfigurationSchema.extend({
    openAIEndpoint: azureOpenAIEndpointSchema.optional(),
    liveDeployment: deploymentSchema,
    astraDeployment: deploymentSchema,
  }),
  overrides: z.object({
    projectEndpoint: z.boolean(),
    openAIEndpoint: z.boolean(),
    liveDeployment: z.boolean(),
    astraDeployment: z.boolean(),
    decisionDeployment: z.boolean(),
    browserControl: z.boolean().optional(),
  }),
  ready: z.boolean(),
  controller: z.object({ mode: z.enum(["astra", "md1-first"]), reason: z.string() }).optional(),
});

export type ResolvedFoundryConfiguration = z.infer<typeof resolvedFoundryConfigurationSchema>;

export const citationSchema = z.object({
  id: z.string(),
  text: z.string(),
  selector: z.string().optional(),
  page: z.number().int().min(1).optional(),
});

export const documentInfoSchema = z.object({
  type: z.literal("pdf"),
  pageCount: z.number().int().min(0),
  truncated: z.boolean(),
});

export const pageContextSchema = z.object({
  url: pageUrlSchema,
  title: z.string(),
  description: z.string(),
  byline: z.string(),
  excerpt: z.string(),
  headings: z.array(
    z.object({
      level: z.number().int().min(1).max(6),
      text: z.string(),
    }),
  ),
  links: z.array(
    z.object({
      text: z.string(),
      href: z.string(),
    }),
  ),
  citations: z.array(citationSchema),
  controls: z.array(z.object({
    selector: z.string(),
    label: z.string(),
    kind: z.string(),
    search: z.boolean(),
    blocked: z.boolean(),
  })).optional(),
  document: documentInfoSchema.optional(),
  capturedAt: z.string(),
});

export type PageContext = z.infer<typeof pageContextSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type DocumentInfo = z.infer<typeof documentInfoSchema>;

export const browserActionSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("get_page_context"), arguments: z.object({ query: z.string().trim().min(1).max(200).optional() }) }),
  z.object({
    name: z.literal("navigate"),
    arguments: z.object({ url: httpUrlSchema }),
  }),
  z.object({
    name: z.literal("click"),
    arguments: z.object({
      selector: z.string().optional(),
      text: z.string().optional(),
    }),
  }),
  z.object({
    name: z.literal("find_and_click"),
    arguments: z.object({ goal: z.string().trim().min(1).max(200) }),
  }),
  z.object({
    name: z.literal("type_text"),
    arguments: z.object({
      selector: z.string(),
      text: z.string(),
      submit: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal("scroll"),
    arguments: z.object({
      direction: z.enum(["up", "down"]),
      amount: z.number().int().min(100).max(4000).default(700),
    }),
  }),
  z.object({
    name: z.literal("highlight"),
    arguments: z.object({
      citationId: z.string().optional(),
      text: z.string().optional(),
    }),
  }),
  z.object({ name: z.literal("go_back"), arguments: z.object({}) }),
  z.object({
    name: z.literal("open_tab"),
    arguments: z.object({ url: httpUrlSchema }),
  }),
  z.object({
    name: z.literal("inspect_viewport"),
    arguments: z.object({ question: z.string() }),
  }),
]);

export type BrowserAction = z.infer<typeof browserActionSchema>;

export const actionResultSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  data: z.unknown().optional(),
  requiresConfirmation: z.boolean().optional(),
  confirmationId: z.string().optional(),
});

export type ActionResult = z.infer<typeof actionResultSchema>;

export const liveSessionRequestSchema = z.object({
  sdp: z.string().min(1),
  page: pageContextSchema.optional(),
  configuration: foundryConfigurationSchema.optional(),
});

export const liveSessionResponseSchema = z.object({
  sessionId: z.string(),
  sdp: z.string(),
  controllerMode: z.enum(["astra", "md1-first"]).default("astra"),
});

export const viewportAnalysisRequestSchema = z.object({
  screenshot: z.string().startsWith("data:image/"),
  question: z.string().min(1),
  page: pageContextSchema,
  configuration: foundryConfigurationSchema.optional(),
});

export const viewportAnalysisResponseSchema = z.object({
  analysis: z.string(),
});

export const MAX_CLICK_TARGETS = 30;

export const clickTargetSchema = z.object({
  id: z.string().regex(/^t\d{1,3}$/),
  selector: z.string().min(1).max(200),
  kind: z.string().max(40),
  label: z.string().max(160),
  href: z.string().max(500).optional(),
  navigates: z.boolean(),
});

export type ClickTarget = z.infer<typeof clickTargetSchema>;

export const clickTargetDecisionRequestSchema = z.object({
  goal: z.string().trim().min(1).max(200),
  page: z.object({ title: z.string().max(300), url: z.string().max(2000) }),
  targets: z.array(clickTargetSchema.omit({ selector: true, navigates: true })).min(1).max(MAX_CLICK_TARGETS),
  configuration: foundryConfigurationSchema.optional(),
});

export const clickTargetDecisionResponseSchema = z.object({
  target: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  confident: z.boolean(),
  ranked: z.array(z.object({ id: z.string(), probability: z.number() })),
});

export type ClickTargetDecision = z.infer<typeof clickTargetDecisionResponseSchema>;

export type TimelineEntry = {
  id: string;
  kind: "user" | "assistant" | "controller" | "action" | "system";
  text: string;
  timestamp: number;
  status?: "pending" | "completed" | "failed";
  citations?: Citation[];
  durationMs?: number;
};

export const irreversibleActionPattern =
  /\b(send|submit|publish|post|delete|remove|download|change password|account setting|confirm order)\b/i;

export const paymentPattern =
  /\b(payment|checkout|credit card|debit card|card number|cvv|cvc|billing|purchase|buy now|place order)\b/i;

export const FAST_LIMITS = Object.freeze({
  actions: 8, decisions: 16, noProgress: 3, durationMs: 60000,
  astraRounds: 16, astraActions: 16, historyBytes: 250000,
});

const identitySchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/);
export const fastScopeSchema = z.object({
  sessionId: identitySchema, runId: identitySchema, revision: z.number().int().nonnegative(),
  tabId: z.number().int().nonnegative(), expiresAtMs: z.number().int().positive(),
}).strict();
export type FastScope = z.infer<typeof fastScopeSchema>;
export const fastOperationSchema = z.enum(["CLICK", "SCROLL_UP", "SCROLL_DOWN", "WAIT", "DONE", "HANDOFF"]);
export const fastSnapshotSchema = z.object({
  documentId: identitySchema, snapshotId: identitySchema,
  url: httpUrlSchema.max(2000), title: z.string().max(300), text: z.string().max(3000),
  viewport: z.object({
    x: z.number().finite(), y: z.number().finite(), width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(), scrollHeight: z.number().finite().nonnegative(),
  }),
  targets: z.array(z.object({
    id: z.string().regex(/^t\d{1,3}$/), kind: z.string().max(40),
    label: z.string().max(160), href: z.string().max(500).optional(), state: z.string().max(100),
  })).max(MAX_CLICK_TARGETS),
  operations: z.array(fastOperationSchema).min(2).max(6),
}).strict();
export type FastSnapshot = z.infer<typeof fastSnapshotSchema>;
export const fastCommandSchema = z.object({
  scope: fastScopeSchema, documentId: identitySchema, snapshotId: identitySchema,
  stepId: identitySchema, operation: fastOperationSchema, targetId: z.string().max(10).optional(),
}).strict();
export type FastCommand = z.infer<typeof fastCommandSchema>;
export const fastSnapshotResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshot: fastSnapshotSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export const fastStepResultSchema = z.object({
  ok: z.boolean(), summary: z.string().max(1000),
  outcome: z.enum(["executed", "rejected", "uncertain"]),
});
export type FastStepResult = z.infer<typeof fastStepResultSchema>;
export const fastDecisionRequestSchema = z.object({
  goal: z.string().trim().min(1).max(4000), snapshot: fastSnapshotSchema,
  history: z.array(z.object({ operation: fastOperationSchema, summary: z.string().max(1000), outcome: z.string().max(20) })).max(8),
  configuration: foundryConfigurationSchema.optional(),
}).strict();
export const fastDecisionResponseSchema = z.object({
  operation: fastOperationSchema, targetId: z.string().nullable(),
  confidence: z.number().finite().min(0).max(1), confident: z.boolean(),
});
export type FastDecision = z.infer<typeof fastDecisionResponseSchema>;

// Preserve complete stateless Responses items, including opaque encrypted reasoning.
export const controllerItemSchema = z.record(z.string(), z.json()).refine((item) =>
  (["function_call", "function_call_output", "reasoning"].includes(String(item.type))) ||
  ((item.type === undefined || item.type === "message") && ["user", "assistant"].includes(String(item.role))),
  "Unsupported controller history item.",
);
export type ControllerItem = z.infer<typeof controllerItemSchema>;
export const controllerRoundRequestSchema = z.object({
  runId: identitySchema, round: z.number().int().min(1).max(FAST_LIMITS.astraRounds),
  input: z.array(controllerItemSchema).min(1).max(100),
  configuration: foundryConfigurationSchema.optional(),
}).strict().refine((value) => new TextEncoder().encode(JSON.stringify(value.input)).byteLength <= FAST_LIMITS.historyBytes,
  "Controller history exceeded its byte budget.");
export const controllerStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), itemId: identitySchema, delta: z.string().max(20000) }),
  z.object({ type: z.literal("completed"), output: z.array(controllerItemSchema).max(100), text: z.string().max(30000) }),
  z.object({ type: z.literal("error"), message: z.string().max(1000) }),
]);
export type ControllerStreamEvent = z.infer<typeof controllerStreamEventSchema>;
