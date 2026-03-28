export type MacroScriptCondition =
    | { type: "pixel"; x: number; y: number; color: string; tolerance: number }
    | { type: "image"; template: string; threshold: number; region?: { x: number; y: number; width: number; height: number }; mode?: "fast" | "precise" };

type MacroScriptBaseNode = {
    lineNo: number;
};

export type MacroScriptNode =
    | (MacroScriptBaseNode & { type: "wait"; ms: number })
    | (MacroScriptBaseNode & { type: "tap"; x: number; y: number })
    | (MacroScriptBaseNode & { type: "tap_match"; offsetX: number; offsetY: number })
    | (MacroScriptBaseNode & { type: "drag"; x1: number; y1: number; x2: number; y2: number; durationMs: number })
    | (MacroScriptBaseNode & { type: "key"; key: string })
    | (MacroScriptBaseNode & { type: "if"; condition: MacroScriptCondition; thenNodes: MacroScriptNode[]; elseNodes: MacroScriptNode[] })
    | (MacroScriptBaseNode & { type: "label"; name: string })
    | (MacroScriptBaseNode & { type: "goto"; label: string })
    | (MacroScriptBaseNode & { type: "for_each"; count: number | null; body: MacroScriptNode[] })
    | (MacroScriptBaseNode & { type: "break" })
    | (MacroScriptBaseNode & { type: "exit" });

export type ParsedMacroScript = {
    nodes: MacroScriptNode[];
    topLevelLabels: Record<string, number>;
};

const RESERVED_LABELS = new Set([
    "break",
    "drag",
    "else",
    "end",
    "exit",
    "for",
    "goto",
    "if",
    "key",
    "tap",
    "tap_match",
    "wait",
]);

function normalizeLabelName(label: string): string {
    return label.trim().toLowerCase();
}

function parseLabelReference(label: string, lineNo: number): string {
    const normalized = normalizeLabelName(label);
    if (!/^[a-z_][a-z0-9_-]*$/i.test(label)) {
        throw new Error(`Invalid label name at line ${lineNo}: ${label}`);
    }
    if (RESERVED_LABELS.has(normalized)) {
        throw new Error(`Reserved keyword cannot be used as label at line ${lineNo}: ${label}`);
    }
    return normalized;
}

function validateNodes(nodes: MacroScriptNode[], topLevelLabels: Record<string, number>, loopDepth: number): void {
    for (const node of nodes) {
        if (node.type === "if") {
            validateNodes(node.thenNodes, topLevelLabels, loopDepth);
            validateNodes(node.elseNodes, topLevelLabels, loopDepth);
            continue;
        }

        if (node.type === "for_each") {
            validateNodes(node.body, topLevelLabels, loopDepth + 1);
            continue;
        }

        if (node.type === "goto" && topLevelLabels[node.label] === undefined) {
            throw new Error(`Unknown label "${node.label}" at line ${node.lineNo}`);
        }

        if (node.type === "break" && loopDepth === 0) {
            throw new Error(`BREAK at line ${node.lineNo} must be used inside FOR EACH`);
        }
    }
}

export function parseMacroScript(source: string): ParsedMacroScript {
    const rawLines = source
        .split(/\r?\n/)
        .map((line, index) => ({ lineNo: index + 1, text: line.trim() }))
        .filter((line) => line.text.length > 0 && !line.text.startsWith("#") && !line.text.startsWith("//"));

    let idx = 0;

    const parseBlock = (
        allowElse: boolean,
        allowLabels: boolean,
    ): { nodes: MacroScriptNode[]; stop: "ELSE" | "END" | "EOF" } => {
        const nodes: MacroScriptNode[] = [];

        while (idx < rawLines.length) {
            const current = rawLines[idx];
            const line = current.text;

            if (/^ELSE$/i.test(line)) {
                if (!allowElse) {
                    throw new Error(`Unexpected ELSE at line ${current.lineNo}`);
                }
                return { nodes, stop: "ELSE" };
            }
            if (/^END$/i.test(line)) {
                return { nodes, stop: "END" };
            }

            const labelMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):$/);
            if (labelMatch) {
                if (!allowLabels) {
                    throw new Error(`Labels are only allowed at the top level (line ${current.lineNo})`);
                }
                nodes.push({
                    type: "label",
                    name: parseLabelReference(labelMatch[1], current.lineNo),
                    lineNo: current.lineNo,
                });
                idx++;
                continue;
            }

            const gotoMatch = line.match(/^GOTO\s+([A-Za-z_][A-Za-z0-9_-]*)$/i);
            if (gotoMatch) {
                nodes.push({
                    type: "goto",
                    label: parseLabelReference(gotoMatch[1], current.lineNo),
                    lineNo: current.lineNo,
                });
                idx++;
                continue;
            }

            const forEachMatch = line.match(/^FOR\s+EACH(?:\s+(\d+))?$/i);
            if (forEachMatch) {
                idx++;
                const bodyBlock = parseBlock(false, false);
                if (bodyBlock.stop !== "END") {
                    throw new Error(`FOR EACH block at line ${current.lineNo} missing END`);
                }
                nodes.push({
                    type: "for_each",
                    count: forEachMatch[1] !== undefined ? Number(forEachMatch[1]) : null,
                    body: bodyBlock.nodes,
                    lineNo: current.lineNo,
                });
                idx++;
                continue;
            }

            if (/^BREAK$/i.test(line)) {
                nodes.push({ type: "break", lineNo: current.lineNo });
                idx++;
                continue;
            }

            if (/^EXIT$/i.test(line)) {
                nodes.push({ type: "exit", lineNo: current.lineNo });
                idx++;
                continue;
            }

            const waitMatch = line.match(/^WAIT\s+(\d+)$/i);
            if (waitMatch) {
                nodes.push({ type: "wait", ms: Number(waitMatch[1]), lineNo: current.lineNo });
                idx++;
                continue;
            }

            const tapMatch = line.match(/^TAP\s+(\d+)\s+(\d+)$/i);
            if (tapMatch) {
                nodes.push({ type: "tap", x: Number(tapMatch[1]), y: Number(tapMatch[2]), lineNo: current.lineNo });
                idx++;
                continue;
            }

            const tapImageMatch = line.match(/^TAP_MATCH(?:\s+OFFSET\s+(-?\d+)\s+(-?\d+))?$/i);
            if (tapImageMatch) {
                nodes.push({
                    type: "tap_match",
                    offsetX: Number(tapImageMatch[1] ?? "0"),
                    offsetY: Number(tapImageMatch[2] ?? "0"),
                    lineNo: current.lineNo,
                });
                idx++;
                continue;
            }

            const dragMatch = line.match(/^DRAG\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/i);
            if (dragMatch) {
                nodes.push({
                    type: "drag",
                    x1: Number(dragMatch[1]),
                    y1: Number(dragMatch[2]),
                    x2: Number(dragMatch[3]),
                    y2: Number(dragMatch[4]),
                    durationMs: Number(dragMatch[5] ?? "200"),
                    lineNo: current.lineNo,
                });
                idx++;
                continue;
            }

            const keyMatch = line.match(/^KEY\s+([A-Z_]+)$/i);
            if (keyMatch) {
                nodes.push({ type: "key", key: keyMatch[1].toUpperCase(), lineNo: current.lineNo });
                idx++;
                continue;
            }

            const pixelIfMatch = line.match(/^IF\s+PIXEL\s+(\d+)\s+(\d+)\s*==\s*(#[0-9a-fA-F]{6})(?:\s+TOL\s+(\d+))?$/i);
            if (pixelIfMatch) {
                idx++;
                const thenBlock = parseBlock(true, false);
                let elseNodes: MacroScriptNode[] = [];
                if (thenBlock.stop === "ELSE") {
                    idx++;
                    const elseBlock = parseBlock(false, false);
                    elseNodes = elseBlock.nodes;
                    if (elseBlock.stop !== "END") {
                        throw new Error(`IF block at line ${current.lineNo} missing END`);
                    }
                } else if (thenBlock.stop !== "END") {
                    throw new Error(`IF block at line ${current.lineNo} missing END`);
                }

                nodes.push({
                    type: "if",
                    condition: {
                        type: "pixel",
                        x: Number(pixelIfMatch[1]),
                        y: Number(pixelIfMatch[2]),
                        color: pixelIfMatch[3].toUpperCase(),
                        tolerance: Number(pixelIfMatch[4] ?? "12"),
                    },
                    thenNodes: thenBlock.nodes,
                    elseNodes,
                    lineNo: current.lineNo,
                });
                idx++;
                continue;
            }

            const imageIfMatch = line.match(/^IF\s+IMAGE\s+(".*?"|\S+)(?:\s+CONF\s*>=\s*([0-9]*\.?[0-9]+))?(?:\s+REGION\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+))?(?:\s+(FAST|PRECISE))?$/i);
            if (imageIfMatch) {
                idx++;
                const thenBlock = parseBlock(true, false);
                let elseNodes: MacroScriptNode[] = [];
                if (thenBlock.stop === "ELSE") {
                    idx++;
                    const elseBlock = parseBlock(false, false);
                    elseNodes = elseBlock.nodes;
                    if (elseBlock.stop !== "END") {
                        throw new Error(`IF IMAGE block at line ${current.lineNo} missing END`);
                    }
                } else if (thenBlock.stop !== "END") {
                    throw new Error(`IF IMAGE block at line ${current.lineNo} missing END`);
                }

                const templateToken = imageIfMatch[1];
                nodes.push({
                    type: "if",
                    condition: {
                        type: "image",
                        template: templateToken.startsWith("\"") && templateToken.endsWith("\"")
                            ? templateToken.slice(1, -1)
                            : templateToken,
                        threshold: Number(imageIfMatch[2] ?? "0.9"),
                        region: imageIfMatch[3]
                            ? {
                                x: Number(imageIfMatch[3]),
                                y: Number(imageIfMatch[4]),
                                width: Number(imageIfMatch[5]),
                                height: Number(imageIfMatch[6]),
                            }
                            : undefined,
                        mode: imageIfMatch[7] ? imageIfMatch[7].toLowerCase() as "fast" | "precise" : undefined,
                    },
                    thenNodes: thenBlock.nodes,
                    elseNodes,
                    lineNo: current.lineNo,
                });
                idx++;
                continue;
            }

            throw new Error(`Unsupported syntax at line ${current.lineNo}: ${line}`);
        }

        return { nodes, stop: "EOF" };
    };

    const root = parseBlock(false, true);
    if (root.stop !== "EOF") {
        throw new Error("Unexpected block terminator at top level");
    }

    const topLevelLabels: Record<string, number> = {};
    for (let nodeIndex = 0; nodeIndex < root.nodes.length; nodeIndex++) {
        const node = root.nodes[nodeIndex];
        if (node.type !== "label") {
            continue;
        }
        if (topLevelLabels[node.name] !== undefined) {
            throw new Error(`Duplicate label "${node.name}" at line ${node.lineNo}`);
        }
        topLevelLabels[node.name] = nodeIndex;
    }

    validateNodes(root.nodes, topLevelLabels, 0);

    return {
        nodes: root.nodes,
        topLevelLabels,
    };
}

export function countExecutableMacroSteps(script: ParsedMacroScript | MacroScriptNode[]): number {
    const nodes = Array.isArray(script) ? script : script.nodes;
    let total = 0;

    for (const node of nodes) {
        if (node.type === "label") {
            continue;
        }
        total += 1;
        if (node.type === "if") {
            total += countExecutableMacroSteps(node.thenNodes);
            total += countExecutableMacroSteps(node.elseNodes);
            continue;
        }
        if (node.type === "for_each") {
            const bodySteps = countExecutableMacroSteps(node.body);
            total += node.count === null ? bodySteps : bodySteps * Math.max(node.count, 0);
        }
    }

    return total;
}
