import * as ts from 'typescript';

type JsxParent = ts.JsxElement | ts.JsxFragment;
const jsxParents = [ts.SyntaxKind.JsxElement, ts.SyntaxKind.JsxFragment];

export default function(_program: ts.Program, _pluginOptions: object) {
    return (ctx: ts.TransformationContext) => {
        return (sourceFile: ts.SourceFile) => {
            function visitor(node: ts.Node): ts.Node {
                try {
                    if (node.kind === ts.SyntaxKind.ImportDeclaration) {
                        const pkg = (node as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral;
                        if (pkg.text === 'jsx-conditionals') return null; // Remove the imports
                    }
                    if (jsxParents.includes(node.kind)) {
                        checkForOrphanedElse(node as JsxParent);
                    }
                    if (isIfNode(node)) {
                        const ifElem = node as ts.JsxElement;
                        return ts.visitEachChild(
                            ctx.factory.createJsxExpression(
                                undefined,
                                ctx.factory.createConditionalExpression(
                                    getConditionExpression(ifElem),
                                    ctx.factory.createToken(ts.SyntaxKind.QuestionToken),
                                    createWhenTrueExpression(ctx, node, ifElem),
                                    ctx.factory.createToken(ts.SyntaxKind.ColonToken),
                                    createWhenFalseExpression(ifElem, ctx, node)
                                )
                            ),
                            visitor, ctx
                        );
                    }
                    if (isElseNode(node)) {
                        // We already processed the <Else> clause so here we can just erase them
                        if (!jsxParents.includes((node as ts.JsxElement).parent.kind)) {
                            throw new Error("<Else> is used a top-level node and has no associated <If> condition");
                        }
                        return null;
                    }
                }
                catch (err) {
                    if (err.message) {
                        err.message = `${err.message}\r\nIn file ${sourceFile.fileName}\r\nAt node ${node.getText()}`;
                    }
                    throw err;
                }
                return ts.visitEachChild(node, visitor, ctx);
            }
            return ts.visitEachChild(sourceFile, visitor, ctx);
        };
    };
}

function checkForOrphanedElse(jsxParent: JsxParent) {
    jsxParent.children.forEach((child, idx) => {
        if (isElseNode(child)) {
            // Found an else, now walk backwards until we find an If
            let currIdx = idx - 1;
            while (currIdx >= 0) {
                const sibling = jsxParent.children[currIdx];
                if (isEmptyTextNode(sibling)) {
                    currIdx--;
                    continue;
                }
                if (isIfNode(sibling)) {
                    return;
                }
            }
            throw new Error("<Else> has no matching <If>. Only whitespace is allowed between them.");
        }
    });
}

function isIfNode(node: ts.Node) {
    return node.kind === ts.SyntaxKind.JsxElement
        && (node as ts.JsxElement).openingElement.tagName.getText() === 'If';
} 

function isElseNode(node: ts.Node) {
    return node.kind === ts.SyntaxKind.JsxElement
        && (node as ts.JsxElement).openingElement.tagName.getText() === 'Else';
}

function isEmptyTextNode(node: ts.Node) {
    return node.kind === ts.SyntaxKind.JsxText
        && (node as ts.JsxText).text.trim().length === 0;
}

function getConditionExpression(jsxElem: ts.JsxElement): ts.Expression {
    const attrName = 'condition';
    let conditionAttr: ts.JsxAttribute = null;

    // forEachChild seems necessary, rather than getChildren().find() not sure why...
    jsxElem.openingElement.attributes.forEachChild(attr => {
        if (attr.kind == ts.SyntaxKind.JsxAttribute) {
            const jsxAttr = attr as ts.JsxAttribute;
            if (jsxAttr.name.getText() === attrName) {
                conditionAttr = jsxAttr;
                return;
            }
        }
    });

    if (!conditionAttr) {
        throw new Error(`Missing '${attrName}' property`);
    }

    const initializer = conditionAttr.initializer;
    if (initializer.kind !== ts.SyntaxKind.JsxExpression) {
        throw new Error(`'${attrName}' property should be type JsxExpression, found ${ts.SyntaxKind[initializer.kind]}`);
    }
    return (initializer as ts.JsxExpression).expression;
}

function createWhenTrueExpression(ctx: ts.TransformationContext, originalNode: ts.Node, jsxElem: ts.JsxElement) {
    return ctx.factory.createJsxFragment(
        createJsxOpeningFragment(ctx, originalNode),
        getJsxChildren(jsxElem),
        ctx.factory.createJsxJsxClosingFragment()
    );
}

function createJsxOpeningFragment(ctx: ts.TransformationContext, originalNode: ts.Node) {
    const openingFrag = ctx.factory.createJsxOpeningFragment();
    ts.setOriginalNode(openingFrag, originalNode); // https://github.com/microsoft/TypeScript/issues/35686
    return openingFrag;
}

function getJsxChildren(parent: JsxParent) {
    const children = parent.getChildren();
    const expectedNumChildren = 3;
    if (children.length !== expectedNumChildren) {
        throw new Error(`${tagToStr(parent)} has ${children.length} children, expected ${expectedNumChildren}`);
    }

    const syntaxList = children[1];
    if (syntaxList.kind !== ts.SyntaxKind.SyntaxList) {
        throw new Error(`${tagToStr(parent)} to contain SyntaxList, found ${ts.SyntaxKind[syntaxList.kind]}`);
    }

    const expectedTypes = [
        ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxExpression, ts.SyntaxKind.JsxElement,
        ts.SyntaxKind.JsxSelfClosingElement, ts.SyntaxKind.JsxFragment
    ];
    const mismatches = syntaxList.getChildren()
        .filter(child => !expectedTypes.includes(child.kind))
        .map(child => ts.SyntaxKind[child.kind]);

    if (mismatches.length > 0) {
        throw new Error('Unexpected type(s) in syntax list: ' + mismatches.join(', '));
    }

    // Safe cast, we checked it
    return syntaxList.getChildren() as ts.JsxChild[];
}

// Create the expression given after the colon (:) in the ternary
function createWhenFalseExpression(ifJsxElem: ts.JsxElement, ctx: ts.TransformationContext, node: ts.Node): ts.Expression {
    if (jsxParents.includes(ifJsxElem.parent.kind)) {
        const elseChildren = getElseBody(ifJsxElem.parent as JsxParent, ifJsxElem);
        // TODO it may be that if there is precisely 1 child, that we can avoid creating the fragment
        if (elseChildren.length > 0) {
            return ctx.factory.createJsxFragment(
                createJsxOpeningFragment(ctx, node),
                elseChildren,
                ctx.factory.createJsxJsxClosingFragment()
            );
        }
    }
    return ctx.factory.createNull();
}

function getElseBody(ifParentElem: JsxParent, ifElem: ts.JsxElement) {
    const ifSiblingNodes = getJsxChildren(ifParentElem);
    let siblingIdx = ifSiblingNodes.findIndex(child => child === ifElem);
    if (siblingIdx < 0) {
        throw new Error('Inexplicable error - <If>s parent does not contain it');
    }

    siblingIdx++; // Skip the <If /> itself
    while (siblingIdx < ifSiblingNodes.length) {
        const sibling = ifSiblingNodes[siblingIdx];
        if (isEmptyTextNode(sibling)) {
            siblingIdx++;
        }
        else if (isElseNode(sibling)) {
            return getJsxChildren(sibling as ts.JsxElement);
        }
        else {
            break;
        }
    }
    return [];
}

function tagToStr(parent: JsxParent) {
    if (parent.kind === ts.SyntaxKind.JsxElement) {
        const jsxElem = parent as ts.JsxElement;
        return `<${jsxElem.openingElement.tagName} />`
    }
    return 'fragment';
}
