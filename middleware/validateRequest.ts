import { Request, Response, NextFunction } from "express";
import { z } from "zod";

const messageRoleEnum = z.enum(["system", "user", "assistant", "tool"]);

const openAIMessageSchema = z.object({
  role: messageRoleEnum,
  content: z.string().nullable().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      })
    )
    .optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

const anthropicContentBlockSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("tool_use"),
      id: z.string(),
      name: z.string(),
      input: z.record(z.string(), z.unknown()),
    }),
    z.object({
      type: z.literal("tool_result"),
      tool_use_id: z.string(),
      content: z.union([
        z.string(),
        z.array(z.lazy(() => anthropicContentBlockSchema)),
      ]),
    }),
  ])
);

const anthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(anthropicContentBlockSchema)]),
});

const openAIToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});

const anthropicToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
});

const requestBodySchema = z.object({
  model: z.string().min(1, "model is required"),
  messages: z
    .array(z.union([openAIMessageSchema, anthropicMessageSchema]))
    .min(1, "messages array must not be empty"),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(z.union([openAIToolSchema, anthropicToolSchema])).optional(),
  tool_choice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  system: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).optional(),
});

export type ValidatedRequestBody = z.infer<typeof requestBodySchema>;

export function validateRequest(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.body || typeof req.body !== "object") {
    res.status(400).json({
      error: "Invalid request body",
      message: "Request body must be a JSON object.",
    });
    return;
  }

  const result = requestBodySchema.safeParse(req.body);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    res.status(400).json({
      error: "Validation failed",
      message: "Request body does not match the expected schema.",
      details: issues,
    });
    return;
  }

  req.body = result.data;
  next();
}
