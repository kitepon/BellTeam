import assert from 'node:assert/strict'
import test from 'node:test'
import {moduleExchangeDiagnostic,validateModuleExchangeDiagnostic as valid} from '../src/module-exchange-diagnostic.mjs'

test('closed diagnostic validator accepts only exact keys, enums, component codes and rollback tuples',()=>{
 const value=moduleExchangeDiagnostic('usage','initialize',{code:'USAGE_IPC_DISCONNECTED'},null);assert.equal(valid(value),true);
 for(const change of [null,[],{}, {...value,extra:'secret'}, {...value,code:'CONVERSATION_IPC_DISCONNECTED'}, {...value,code:'SECRET'.repeat(300)}, {...value,stage:'other'}, {...value,rollback:'failed'}, {...value,rollbackStage:'resume'}, {...value,component:'members'}, {...value,schema:'other'}, {...value,code:undefined}])assert.equal(valid(change),false);
 const failed=moduleExchangeDiagnostic('conversation','ready',{code:'ENOENT'},'prepare',{code:'EACCES'});assert.equal(valid(failed),true);
 const missing={...value};delete missing.code;assert.equal(valid(missing),false);
 const huge=Object.assign(Object.create({toJSON:()=>('x'.repeat(1025))}),value);assert.equal(valid(huge),false);
})

test('unknown codes and throwing error properties cannot overwrite the exchange failure',()=>{
 const error={get code(){throw Error('secret')}};const value=moduleExchangeDiagnostic('usage','ready',error,'channel',error);
 assert.equal(value.code,null);assert.equal(value.rollbackCode,null);assert.equal(valid(value),true);
 const bad={get schema(){throw Error('secret')}};assert.equal(valid(bad),false);
})
