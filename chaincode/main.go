package main

import (
	"fmt"
	"os"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func main() {
	cc, err := contractapi.NewChaincode(&KYCContract{})
	if err != nil {
		fmt.Printf("Error creating KYC chaincode: %s\n", err)
		return
	}
	if err := cc.Start(); err != nil {
		fmt.Printf("Error starting KYC chaincode: %s\n", err)
		os.Exit(1)
	}
}
