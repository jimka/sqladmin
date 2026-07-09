import { describe, it, expect } from "vitest";
import { groupBySchema } from "./groupBySchema";
import type { DiagramData } from "@jimka/typescript-ui/component/diagram";

describe("groupBySchema", () => {
    it("wraps a schema's leaves into one container, id schema:<schema>, label = schema, folder glyph", () => {
        const flat: DiagramData = {
            nodes: [
                { id: "a.users", label: "users", data: { schema: "a", table: "users" } },
                { id: "a.orders", label: "orders", data: { schema: "a", table: "orders" } },
            ],
            edges: [],
        };

        const grouped = groupBySchema(flat);

        expect(grouped.nodes).toEqual([
            {
                id: "schema:a",
                label: "a",
                glyph: "folder",
                children: [
                    { id: "a.users", label: "users", data: { schema: "a", table: "users" } },
                    { id: "a.orders", label: "orders", data: { schema: "a", table: "orders" } },
                ],
            },
        ]);
    });

    it("builds one container per schema, in first-seen order", () => {
        const flat: DiagramData = {
            nodes: [
                { id: "b.x", data: { schema: "b", table: "x" } },
                { id: "a.y", data: { schema: "a", table: "y" } },
                { id: "b.z", data: { schema: "b", table: "z" } },
            ],
            edges: [],
        };

        const grouped = groupBySchema(flat);

        expect(grouped.nodes.map(n => n.id)).toEqual(["schema:b", "schema:a"]);
        expect(grouped.nodes[0].children?.map(c => c.id)).toEqual(["b.x", "b.z"]);
        expect(grouped.nodes[1].children?.map(c => c.id)).toEqual(["a.y"]);
    });

    it("passes edges and layoutOptions through verbatim", () => {
        const flat: DiagramData = {
            nodes: [
                { id: "a.x", data: { schema: "a", table: "x" } },
                { id: "a.y", data: { schema: "a", table: "y" } },
            ],
            edges: [{ id: "e", source: "a.x", target: "a.y" }],
            layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
        };

        const grouped = groupBySchema(flat);

        expect(grouped.edges).toEqual(flat.edges);
        expect(grouped.layoutOptions).toEqual(flat.layoutOptions);
    });

    it("omits a schema with zero surviving leaves", () => {
        const flat: DiagramData = { nodes: [], edges: [] };

        const grouped = groupBySchema(flat);

        expect(grouped.nodes).toEqual([]);
    });
});
