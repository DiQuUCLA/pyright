/*
* scope.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* Represents a symbolic scope and its defined symbols. Unlike
* a "Namespace", a scope object tracks dynamic (runtime)
* bindings between names types. The analyzer stores these types
* in the scope as it walks through the program, effective doing
* what the Python interpreter will do.
*/

import * as assert from 'assert';

import { DefaultTypeSourceId, InferredType, TypeSourceId } from './inferredType';
import { Declaration, Symbol, SymbolTable } from './symbol';
import { TypeConstraint } from './typeConstraint';
import { TypeConstraintUtils } from './typeConstraintUtils';
import { Type, UnboundType } from './types';
import { TypeUtils } from './typeUtils';

export enum ScopeType {
    // Temporary scopes are used temporarily during analysis
    // to represent conditional blocks.
    Temporary,

    // Local scopes are used for lambdas, functions and classes.
    Local,

    // Global scopes are used for modules.
    Global,

    // Built-in scopes are used for all ambient symbols provided
    // by the Python environment.
    BuiltIn
}

export class Scope {
    // The scope type, as defined in the enumeration.
    private _scopeType: ScopeType;

    // The next scope in the hierarchy or undefined if it's the
    // top-most scope.
    private _parent?: Scope;

    // Associations between names, type, and declarations.
    private _symbolTable: SymbolTable = new SymbolTable();

    // Names not in _exportFilterMap will be hidden from child scopes.
    private _exportFilterMap: { [name: string]: string } | undefined;

    // Indicates whether the scope is conditionally executed
    // (i.e. is not guaranteed to be executed).
    private _isConditional: boolean;

    // Indicates whether the scope is associated with a looping
    // construct like while or for.
    private _isLooping = false;

    // Indicates whether the scope is guaranteed not to be
    // executed because a condition is statically determined
    // to be always true or false.
    private _isNotExecuted: boolean;

    // Tracks whether the code flow for the scope always returns
    // before exiting the block.
    private _alwaysReturns = false;

    // Tracks whether the code flow for the scope always raises
    // an exception before exiting the block.
    private _alwaysRaises = false;

    // Tracks whether a "break" statement was executed within
    // the loop.
    private _breaksFromLoop = false;

    // Inferred return and yield types for the scope.
    private _returnType = new InferredType();
    private _yieldType = new InferredType();

    // Active type constraints for this scope -- used for conditional
    // scopes where the condition constrains the types of certain
    // expressions.
    private _typeConstraints: TypeConstraint[] = [];

    constructor(type: ScopeType, parent?: Scope) {
        this._scopeType = type;
        this._parent = parent;
        this._isConditional = false;
        this._isNotExecuted = false;
    }

    setExportFilter(namesToExport: string[]) {
        this._exportFilterMap = {};
        for (const name of namesToExport) {
            this._exportFilterMap[name] = name;
        }
    }

    getSymbolTable(): SymbolTable {
        return this._symbolTable;
    }

    getSymbols(): string[] {
        return this._symbolTable.getKeys();
    }

    getType(): ScopeType {
        return this._scopeType;
    }

    getParent(): Scope | undefined {
        return this._parent;
    }

    setParent(scope?: Scope) {
        this._parent = scope;
    }

    getReturnType(): InferredType {
        return this._returnType;
    }

    getYieldType(): InferredType {
        return this._yieldType;
    }

    setConditional() {
        // Only temporary scopes can be conditional.
        assert(this._scopeType === ScopeType.Temporary);
        this._isConditional = true;
    }

    setUnconditional() {
        // Only temporary scopes can be conditional.
        assert(this._scopeType === ScopeType.Temporary);
        this._isConditional = false;
    }

    isConditional() {
        return this._isConditional;
    }

    setIsNotExecuted() {
        this._isNotExecuted = true;
    }

    isNotExecuted() {
        return this._isNotExecuted;
    }

    setIsLooping() {
        this._isLooping = true;
    }

    lookUpSymbol(name: string): Symbol | undefined {
        return this._symbolTable.get(name);
    }

    lookUpSymbolRecursive(name: string): SymbolWithScope | undefined {
        return this._lookUpSymbolRecursiveInternal(name, false, false);
    }

    lookUpSymbolFromPermanentScope(name: string): SymbolWithScope | undefined {
        // If this is a temporary scope, recurse until we get to a
        // permanent scope.
        if (this._scopeType === ScopeType.Temporary) {
            return this._parent!.lookUpSymbolFromPermanentScope(name);
        }

        return this.lookUpSymbolRecursive(name);
    }

    // Adds a new (unbound) symbol to the scope.
    addUnboundSymbol(name: string): Symbol {
        let symbol = new Symbol(UnboundType.create(), DefaultTypeSourceId);
        this._symbolTable.set(name, symbol);
        return symbol;
    }

    // Binds a type to an existing name in the scope.
    setSymbolCurrentType(name: string, type: Type, typeSourceId: TypeSourceId): boolean {
        const symbol = this._symbolTable.get(name);
        if (symbol) {
            return symbol.setCurrentType(type, typeSourceId);
        } else {
            this._symbolTable.set(name, new Symbol(type, typeSourceId));
            return true;
        }
    }

    addSymbolDeclaration(name: string, declaration: Declaration) {
        const symbol = this._symbolTable.get(name)!;
        assert(symbol !== undefined);

        symbol.addDeclaration(declaration);
    }

    // Merges a specified temporary scope into another scope (which is
    // assumed to be its parent or a direct ancestor). Returns true if
    // a scope was modified in a meaningful way.
    mergeSymbolTable(scopeToMerge: Scope): boolean {
        assert(scopeToMerge.getType() === ScopeType.Temporary);

        let modifiedType = false;

        for (let name of scopeToMerge._symbolTable.getKeys()) {
            let symbolToMerge = scopeToMerge._symbolTable.get(name)!;
            let mergeConditional = scopeToMerge.isConditional() || !!symbolToMerge.isConditional;
            let targetScope: Scope;

            if (this._scopeType === ScopeType.Temporary) {
                targetScope = this;
            } else {
                let scopeWithName = this.lookUpSymbolRecursive(name);
                if (!scopeWithName) {
                    continue;
                }

                // Always merge non-local scopes conditionally.
                if (scopeWithName.scope !== this) {
                    mergeConditional = true;
                }
                targetScope = scopeWithName.scope;
            }

            // Determine the merged type. In the non-conditional case, we simply use the
            // new type. In the conditional case, we may need to combine two types.
            let newType = symbolToMerge.currentType;
            let markTypeConditional = false;
            if (mergeConditional) {
                if (targetScope._isConditional) {
                    // If the target scope is conditional and we don't know the
                    // existing type to merge, mark the entry as "conditional" so it
                    // is properly merged later.
                    const targetSymbol = targetScope._symbolTable.get(name);
                    if (targetSymbol) {
                        newType = TypeUtils.combineTypes([newType, targetSymbol.currentType]);
                    } else {
                        markTypeConditional = true;
                    }
                } else {
                    let existingBinding = targetScope.lookUpSymbolRecursive(name);
                    if (existingBinding) {
                        newType = TypeUtils.combineTypes([newType, existingBinding.symbol.currentType]);
                    }
                }
            }

            // Update the current type.
            if (targetScope.setSymbolCurrentType(name, newType,
                    symbolToMerge.inferredType.getPrimarySourceId())) {
                if (targetScope.getType() !== ScopeType.Temporary) {
                    modifiedType = true;
                }
            }

            // Merge the declarations.
            if (symbolToMerge.declarations) {
                symbolToMerge.declarations.forEach(decl => {
                    targetScope.addSymbolDeclaration(name, decl);
                });
            }

            // Update the "conditional" flag if requested.
            if (markTypeConditional) {
                targetScope._symbolTable.get(name)!.isConditional = true;
            }
        }

        // If the scope we're merging isn't conditional, transfer
        // the return and raises flags.
        if (!scopeToMerge._isConditional) {
            if (scopeToMerge.getAlwaysReturns()) {
                this.setAlwaysReturns();
            }

            if (scopeToMerge.getAlwaysRaises()) {
                this.setAlwaysRaises();
            }
        }

        // If the scope we're merging isn't a looping scope,
        // transfer the break to the this scope. This allows the break
        // to propagate to the nearest looping scope but no further.
        if (!scopeToMerge._isLooping && scopeToMerge._breaksFromLoop) {
            this._breaksFromLoop = true;
        }

        const typeConstraints = TypeConstraintUtils.dedupeTypeConstraints(
            scopeToMerge.getTypeConstraints(), scopeToMerge.isConditional());
        this.addTypeConstraints(typeConstraints);

        return modifiedType;
    }

    // Combines a conditional scope with another conditional scope --
    // for example, an "if" scope with an "else" scope.
    static combineConditionalScopes(scope1: Scope, scope2: Scope): Scope {
        assert(scope1._isConditional && scope2._isConditional);
        assert(scope1._scopeType === ScopeType.Temporary && scope2._scopeType === ScopeType.Temporary);
        assert(!scope1._alwaysReturns && !scope2._alwaysReturns);
        assert(!scope1._alwaysRaises && !scope2._alwaysRaises);
        assert(scope1._parent === scope2._parent);

        const combinedScope = new Scope(ScopeType.Temporary, scope1.getParent());

        // Handle names that are in the second scope that are also in the first
        // scope or are unique to the second scope.
        scope2._symbolTable.forEach((scope2Symbol, name) => {
            const scope1Symbol = scope1._symbolTable.get(name);

            if (scope1Symbol) {
                const combinedSymbol = combinedScope.addUnboundSymbol(name);
                combinedSymbol.setCurrentType(
                    TypeUtils.combineTypes([scope1Symbol.currentType, scope2Symbol.currentType]),
                    scope2Symbol.inferredType.getPrimarySourceId());

                if (scope1Symbol.declarations) {
                    scope1Symbol.declarations.forEach(decl => {
                        combinedSymbol.addDeclaration(decl);
                    });
                }

                if (scope2Symbol.declarations) {
                    scope2Symbol.declarations.forEach(decl => {
                        combinedSymbol.addDeclaration(decl);
                    });
                }

                if (scope1Symbol.isConditional || scope2Symbol.isConditional) {
                    combinedSymbol.isConditional = true;
                }
            } else {
                const newSymbol = new Symbol(scope2Symbol.currentType,
                    scope2Symbol.inferredType.getPrimarySourceId());
                if (scope2Symbol.declarations) {
                    scope2Symbol.declarations.forEach(decl => {
                        newSymbol.addDeclaration(decl);
                    });
                }
                newSymbol.isConditional = true;
                combinedScope._symbolTable.set(name, newSymbol);
            }
        });

        // Handle names that are only in the first scope.
        scope1._symbolTable.forEach((scope1Symbol, name) => {
            if (!scope2._symbolTable.get(name)) {
                const newSymbol = new Symbol(scope1Symbol.currentType,
                    scope1Symbol.inferredType.getPrimarySourceId());
                if (scope1Symbol.declarations) {
                    scope1Symbol.declarations.forEach(decl => {
                        newSymbol.addDeclaration(decl);
                    });
                }
                newSymbol.isConditional = true;
                combinedScope._symbolTable.set(name, newSymbol);
            }
        });

        // Combine type constraints from the two scopes.
        const combinedTypeConstraints = TypeConstraintUtils.combineTypeConstraints(
            scope1.getTypeConstraints(), scope2.getTypeConstraints());
        combinedScope.addTypeConstraints(combinedTypeConstraints);

        // Combine the return and yield types.
        combinedScope._returnType.addSources(scope1._returnType);
        combinedScope._returnType.addSources(scope2._returnType);

        combinedScope._yieldType.addSources(scope1._yieldType);
        combinedScope._yieldType.addSources(scope2._yieldType);

        return combinedScope;
    }

    mergeReturnType(scopeToMerge: Scope): boolean {
        return this._returnType.addSources(scopeToMerge._returnType);
    }

    mergeYieldType(scopeToMerge: Scope): boolean {
        return this._yieldType.addSources(scopeToMerge._yieldType);
    }

    setAlwaysReturns() {
        this._alwaysReturns = true;
    }

    getAlwaysReturns() {
        return this._alwaysReturns;
    }

    setAlwaysRaises() {
        this._alwaysRaises = true;
    }

    clearAlwaysRaises() {
        this._alwaysRaises = false;
    }

    getAlwaysRaises() {
        return this._alwaysRaises;
    }

    getAlwaysReturnsOrRaises() {
        return this._alwaysReturns || this._alwaysRaises;
    }

    setBreaksFromLoop() {
        this._breaksFromLoop = true;
    }

    getBreaksFromLoop() {
        return this._breaksFromLoop;
    }

    getTypeConstraints() {
        return this._typeConstraints;
    }

    addTypeConstraint(constraint: TypeConstraint) {
        this._typeConstraints.push(constraint);
    }

    clearTypeConstraints() {
        this._typeConstraints = [];
    }

    addTypeConstraints(constraints: TypeConstraint[]) {
        constraints.forEach(constraint => {
            this.addTypeConstraint(constraint);
        });
    }

    private _lookUpSymbolRecursiveInternal(name: string, isOutsideCallerModule: boolean,
            isBeyondLocalScope: boolean): SymbolWithScope | undefined {

        // If we're searching outside of the original caller's module (global) scope,
        // hide any names that are not meant to be visible to importers.
        if (isOutsideCallerModule && this._exportFilterMap && !this._exportFilterMap[name]) {
            return undefined;
        }

        const symbol = this._symbolTable.get(name);
        if (symbol) {
            return {
                symbol,
                isBeyondLocalScope,
                isOutsideCallerModule,
                scope: this
            };
        }

        if (this._parent) {
            // If our recursion is about to take us outside the scope of the current
            // module (i.e. into a built-in scope), indicate as such with the second parameter.
            return this._parent._lookUpSymbolRecursiveInternal(name,
                isOutsideCallerModule || this._scopeType === ScopeType.Global,
                isBeyondLocalScope || this._scopeType !== ScopeType.Temporary);
        }

        return undefined;
    }
}

export interface SymbolWithScope {
    symbol: Symbol;
    isBeyondLocalScope: boolean;
    isOutsideCallerModule: boolean;
    scope: Scope;
}
