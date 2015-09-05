var solc = require("./Routes.js").solc;
var Account = require("./Account.js");
var Address = require("./Address.js");
var Int = require("./Int.js");
var Transaction = require("./Transaction.js");
var Storage = require("./Storage.js");
var EthWord = require("./Storage.js").Word;
var sha3 = require("./Crypto").sha3;
var Promise = require('bluebird');
var nodeEnum = require('enum');

var solidityType = require("./solidityType.js");
var readSolVar = solidityType.readSolVar;
var readInput = solidityType.readInput;
var solMethod = solidityType.solMethod;
var mapArg = solidityType.mapArg;
var isDynamic = solidityType.isDynamic;
var dynamicRow = solidityType.dynamicRow;

module.exports = Solidity;
function Solidity(code) {
    return solc(code).then(function(x) {
        var result = Object.create(Solidity.prototype);
        result.code = code;
        result.name = x.name;
        result.vmCode = x.vmCode;
        result.symTab = x.symTab;
        return result;
    }).catch(function(e) {
        throw "Solidity(code): " + e;
    });
}
Solidity.prototype = {
    "code" : "",
    "name" : "",
    "vmCode" : null,
    "symTab" : null,
    "constructor" : Solidity,
    "newContract" : SolContract
};

// txParams = {value, gasPrice, gasLimit} privkey
function SolContract(privkey, txParams) {
    var solObj = this;
    if (txParams === undefined) {
        txParams = {};
    }
    txParams.data = this.vmCode;
    return Transaction(txParams)(privkey, null).get("contractsCreated").
        then(function(addrList){
            if (addrList.length !== 1) {
                throw "code must create one and only one account";
            }
            
            var newAddr = Address(addrList[0]);
            var storage = new Storage(newAddr);
            var result = Object.create(solObj);
            result.state = {};
            result.account = new Account(newAddr);

            var symTab = solObj.symTab;
            for (var sym in symTab) {
                var symRow = symTab[sym];
                if (!("atStorageKey" in symRow)) {
                    if (symRow["jsType"] === "Function") {
                        result.state[sym] = solMethod(symRow);
                        var prop = result.state[sym]
                        prop.callFrom = prop.callToFrom.bind(prop, newAddr);
                        delete prop.callToFrom;
                    }
                    continue;
                }
                
                Object.defineProperty(result.state, sym, {
                    get : makeSolObject(symTab, symRow, storage),
                    enumerable: true
                });
            }
            return result;
        });
};

function makeSolObject(symTab, symRow, storage) {
    switch (symRow["jsType"]) {
    case "Mapping":
        var mapKey = EthWord(symRow["atStorageKey"]).toString();
        var keyRow = symRow["mappingKey"];
        var valRow = symRow["mappingValue"];
        
        function doMap(x) {
            var keyBytes = mapArg(keyRow, readInput(keyRow, x));
            var key = sha3(keyBytes + mapKey);
            valRow["atStorageKey"] = key;
            return makeSolObject(symTab, valRow, storage)();
        };

        return function() {
            return doMap;
        };
    case "Struct":
        var userName = symRow["solidityType"];
        var structFields = symTab[userName]["structFields"];
        var baseKey = Int("0x" + symRow["atStorageKey"]);

        return function () {
            var result = {};
            for (var field in structFields) {
                var structField = structFields[field];
                var fieldRow = {};
                for (var name in structFields[field]) {
                    fieldRow[name] = structField[name];
                }
                var fieldKey = Int("0x" + fieldRow["atStorageKey"]);
                var realKey = baseKey.plus(fieldKey).toString(16);
                fieldRow["atStorageKey"] = realKey;
                if (isDynamic(fieldRow)) {
                    var realKey32 = EthWord(realKey).toString();
                    fieldRow["arrayDataStart"] = sha3(realKey32);
                }
                result[field] = makeSolObject(symTab, fieldRow, storage)();
            }
            return Promise.props(result);
        }
    case "Enum":
        var userName = symRow["solidityType"];
        var enumNames = symTab[userName]["enumNames"];
        var enumType = new nodeEnum(nameMap);
        Object.defineProperties(enumType, {
            size        : { enumerable : false },
            indirection : { enumerable : false },
            _options    : { enumerable : false },
            isFlaggable : { enumerable : false }
        });
        Object.seal(enumType);

        var symRow1 = {};
        for (name in symRow) {
            symRow1[name] = symRow[name];
        }
        symRow1["jsType"] = "Int";

        return function () {
            return readSolVar(symRow1, storage).call("valueOf").then(enumType.get).
                then(function(enumVal) {
                    Object.defineProperties(enumVal,{_options:{enumerable:false}});
                });
        }
    case "Array":
        return function () {
            if (isDynamic(symRow)) {
                symRow = dynamicRow(symRow, storage);
            }
            
            return Promise.join(symRow, function(symRow) {
                var arrElt = symRow["arrayElement"];
                var eltRow = {};
                for (var name in arrElt) {
                    eltRow[name] = arrElt[name];
                };
                eltRow["atStorageKey"] = symRow["atStorageKey"];
                eltRow["atStorageOffset"] = "0x0";

                var eltSize = parseInt(eltRow["bytesUsed"],16);
                var numElts = parseInt(symRow["arrayLength"],16);

                var arrayCR = parseInt(symRow["arrayNewKeyEach"],16);
                var arrayCRSkip = (eltSize < 32 ? 1 : eltSize / 32);

                var result = [];
                while (result.length < numElts) {
                    result.push(makeSolObject(symTab, eltRow, storage)());
                    
                    if (result.length % arrayCR == 0) {
                        var oldKey = Int("0x" + eltRow["atStorageKey"]);
                        eltRow["atStorageKey"] =
                            oldKey.plus(arrayCRSkip).toString(16);
                        eltRow["atStorageOffset"] = "0x0";
                    }
                    else {
                        var oldOff = parseInt(eltRow["atStorageOffset"]);
                        eltRow["atStorageOffset"] =
                            (eltSize + oldOff).toString(16);
                    }
                }
                return Promise.all(result);
            });
        }
    default:
        return readSolVar.bind(null, symRow, storage);
    }
}
