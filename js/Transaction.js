var ethTransaction = require('ethereumjs-tx');
var utils = require('ethereumjs-util');
var HTTPQuery = require("./HTTPQuery.js");
var Address = require("./Address.js");

module.exports = Transaction;

// argObj = {
//   fromAccount:, toAccount:, data:, value:, gasPrice:, gasLimit:
// }
function Transaction(argObj) {
    var result = {
        from       : argObj.fromAccount.address,
        gasPrice   : argObj.gasPrice,
        gasLimit   : argObj.gasLimit,
        value      : argObj.value,
        codeOrData : argObj.data,

        // These are set when sending because the nonce must be current
        nonce : undefined,
        r : undefined,
        s : undefined,
        v : undefined,
        hash : undefined,
    };
    
    if (argObj.toAccount.address !== null) {
        result.to = argObj.toAccount.address;
    }

    // Don't show up in the JSON
    Object.defineProperties(result, {
        "send":{value:sendTransaction, enumerable:false},
        "contractCreated":{value:getContractCreated, enumerable:false},
        "_fromAccount":{value:argObj.fromAccount, enumerable:false}
    });

    return result;
}

function getContractCreated(apiURL, callback) {
    function firstContractCreated(txResult) {
        if (typeof callback === "function") {
            var firstC = txResult[0].contractsCreated.split(",")[0];
            callback(Address(firstC));
        }
    }

    HTTPQuery({
        "serverURI":apiURL,
        "queryPath":"/transactionResult/" + this.hash,
        "get":{},
        "callback":firstContractCreated
    });
}

function setCryptData(apiURL, callback) {
    var tx = new ethTransaction();

    tx.gasPrice = this.gasPrice;
    tx.gasLimit = this.gasLimit;
    tx.value = this.value;
    tx.data = this.codeOrData;
    if (typeof this.to !== "undefined") {
        tx.to = this.to.valueOf();
    }

    function copyCryptData () {
        this.nonce = this._fromAccount.nonce;
        tx.nonce = this.nonce.valueOf();
        tx.sign(this._fromAccount.privateKey);
        this.r = (tx.r).toString('hex');
        this.s = (tx.s).toString('hex');
        this.v = (tx.v).toString('hex');
        this.hash = tx.hash().toString('hex');

        callback();
    }

    this._fromAccount.sync(apiURL, copyCryptData.bind(this));
}

function sendTransaction(apiURL, callback) {
    function pollAndCallback() {
        var poller = setInterval(pollTX.bind(this), 500);
        function pollTX () {
            HTTPQuery({
                "serverURI":apiURL,
                "queryPath":"/transaction",
                "get":{"hash":this.hash},
                "callback":checkTXPosted.bind(this)
            });
        }
        function checkTXPosted(txList) {
            if (txList.length != 0) {
                clearInterval(poller);
                if (typeof callback === "function") {
                    callback(this);
                }
            }
        }
    }

    function makeJSONQuery() {
        this.value = this.value.toString(); // Stupid
        HTTPQuery({
            "serverURI":apiURL,
            "queryPath":"/transaction",
            "data":this,
            "callback":pollAndCallback.bind(this)
        });
    }

    setCryptData.bind(this)(apiURL, makeJSONQuery.bind(this));
}