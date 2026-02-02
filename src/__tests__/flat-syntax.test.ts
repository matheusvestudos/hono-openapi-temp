import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import z from "zod";
import "zod-openapi/extend";
import { generateSpecs } from "../handler.js";
import { describeRoute } from "../middlewares.js";

describe("Flat Syntax", () => {
  it("simple schema", async () => {
    const app = new Hono().get(
      "/",
      describeRoute({
        description: "Test route",
        responses: {
          200: {
            description: "Success",
            schema: z.object({
              message: z.string(),
            }),
          },
        },
      }),
      async (c) => {
        return c.json({ message: "Hello, world!" });
      },
    );

    const specs = await generateSpecs(app);
    expect(specs).toMatchSnapshot();

    // Check if structure is correct manually as well
    const response200 = specs.paths?.['/']?.get?.responses?.['200'] as any;
    expect(response200.content['application/json'].schema).toBeDefined();
    expect(response200.schema).toBeUndefined();
  });

  it("custom type", async () => {
    const app = new Hono().get(
      "/",
      describeRoute({
        description: "Test route",
        responses: {
          400: {
            description: "Bad Request",
            type: "application/problem+json",
            schema: z.object({
              error: z.string(),
            }),
          },
        },
      }),
      async (c) => {
        return c.json({ error: "Something went wrong" });
      },
    );

    const specs = await generateSpecs(app);
    expect(specs).toMatchSnapshot();

    const response400 = specs.paths?.['/']?.get?.responses?.['400'] as any;
    expect(response400.content['application/problem+json'].schema).toBeDefined();
  });

  it("with status property (cleaned up)", async () => {
    const app = new Hono().get(
      "/",
      describeRoute({
        description: "Test route",
        responses: {
          200: {
            description: "Success",
            status: 200,
            schema: z.object({
              message: z.string(),
            }),
          },
        },
      }),
      async (c) => {
        return c.json({ message: "Hello" });
      },
    );

    const specs = await generateSpecs(app);
    const response200 = specs.paths?.['/']?.get?.responses?.['200'] as any;
    expect(response200.status).toBeUndefined();
  });
});
