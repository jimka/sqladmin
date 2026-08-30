import { describe, it, expect } from "vitest";
import { yesNo } from "../src/textFormat";

describe("yesNo", () => {
    it("renders true as Yes", () => {
        expect(yesNo(true)).toBe("Yes");
    });

    it("renders false as No", () => {
        expect(yesNo(false)).toBe("No");
    });
});
