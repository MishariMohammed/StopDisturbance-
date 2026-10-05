import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

// RTL: physical-direction Tailwind classes are banned; use start/end (04-ux §11.2).
const PHYSICAL = /\b-?(ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|text-left|text-right|float-left|float-right)(-|\b)/;

const noPhysicalDirection = {
  meta: { type: "problem", messages: { physical: "Use logical (start/end) Tailwind classes instead of '{{cls}}' (RTL)." } },
  create(context) {
    const check = (node, value) => {
      if (typeof value !== "string") return;
      for (const cls of value.split(/\s+/)) {
        if (PHYSICAL.test(cls.replace(/^[a-z-]+:/, ""))) context.report({ node, messageId: "physical", data: { cls } });
      }
    };
    return {
      JSXAttribute(node) {
        if (node.name.name !== "className" || !node.value) return;
        if (node.value.type === "Literal") check(node, node.value.value);
        if (node.value.type === "JSXExpressionContainer" && node.value.expression.type === "TemplateLiteral") {
          for (const q of node.value.expression.quasis) check(node, q.value.cooked);
        }
      },
    };
  },
};

const config = [
  { ignores: [".next/**", ".next-*/**", "dist/**", "node_modules/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    plugins: { sd: { rules: { "no-physical-direction": noPhysicalDirection } } },
    rules: { "sd/no-physical-direction": "error" },
  },
];

export default config;
