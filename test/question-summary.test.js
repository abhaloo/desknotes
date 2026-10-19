import test from "node:test";
import assert from "node:assert/strict";
import { summarizeQuestion } from "../src/desktop/renderer/question-summary.js";

/** The question line names the ask, not the whole question. */
const GREENHOUSE =
  "A company operates commercial greenhouses across multiple regions. Each greenhouse contains sensors measuring temperature, humidity, and soil moisture. We need a service that continuously ingests those readings and provides a dashboard showing current conditions, historical trends, and anomaly alerts. Your task is to design the back-end architecture. Start by clarifying the requirements, then walk us through your design. You can use diagrams or notes.";

const CASES = [
  [GREENHOUSE, "Design the back-end architecture"],
  [
    "Walk me through your architecture, starting with a sensor reading and ending with the dashboard and any resulting alert. Ask the candidate to cover. 1. Scale estimates. Average ingestion rate, peak load, and storage growth.",
    "Walk me through your architecture, starting with a sensor reading and ending with the dashboard and any resulting alert",
  ],
  [
    "2. Describe a back-end or distributed system you helped design. What did you personally own? 3.",
    "Describe a back-end or distributed system you helped design",
  ],
  [
    "So, um, how would you design a rate limiter for 100k requests per second?",
    "How would you design a rate limiter for 100k requests per second?",
  ],
  [
    "Could you explain the difference between any and unknown in TypeScript?",
    "Explain the difference between any and unknown in TypeScript",
  ],
  ["how much is the enterprise plan", "How much is the enterprise plan"],
  ["We use Salesforce today. Does it integrate with HubSpot too?", "Does it integrate with HubSpot too?"],
  [
    "What does 99.9% uptime allow per year, e.g. in minutes?",
    "What does 99.9% uptime allow per year, e.g. in minutes?",
  ],
  ["We have a monolith. It is slow under load.", "We have a monolith"],
  ["I'd like you to, um, build a queue.", "Build a queue"],
  ["Can you say why?", "Can you say why?"],
  ["Music", "Music"],
  ["", ""],
  ["   ", ""],
];

for (const [input, expected] of CASES) {
  test(`summarizeQuestion: ${JSON.stringify(input.slice(0, 48))}`, () => {
    assert.equal(summarizeQuestion(input), expected);
  });
}
