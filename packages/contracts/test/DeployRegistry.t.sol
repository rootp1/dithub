// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DeployRegistry} from "../src/DeployRegistry.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function warp(uint256) external;
}

contract DeployRegistryTest {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    event ReleasePublished(
        uint256 indexed id, bytes32 indexed commit, bytes32 bundleHash, string url, address indexed publisher
    );

    address internal constant OWNER = address(0xA11CE);
    address internal constant PUB = address(0xB0B);
    address internal constant STRANGER = address(0xBAD);
    DeployRegistry internal reg;

    function setUp() public {
        reg = new DeployRegistry(OWNER);
        vm.prank(OWNER);
        reg.setPublisher(PUB, true);
    }

    function testConstructorRejectsZeroOwner() public {
        vm.expectRevert(DeployRegistry.ZeroAddress.selector);
        new DeployRegistry(address(0));
    }

    function testOnlyOwnerSetsPublisher() public {
        vm.prank(STRANGER);
        vm.expectRevert(DeployRegistry.NotOwner.selector);
        reg.setPublisher(STRANGER, true);
    }

    function testOnlyPublisherCanPublish() public {
        vm.prank(STRANGER);
        vm.expectRevert(DeployRegistry.NotPublisher.selector);
        reg.publish(bytes32(uint256(1)), bytes32(uint256(2)), "u");
        // owner is not automatically a publisher
        vm.prank(OWNER);
        vm.expectRevert(DeployRegistry.NotPublisher.selector);
        reg.publish(bytes32(uint256(1)), bytes32(uint256(2)), "u");
    }

    function testRevokedPublisherCannotPublish() public {
        vm.prank(OWNER);
        reg.setPublisher(PUB, false);
        vm.prank(PUB);
        vm.expectRevert(DeployRegistry.NotPublisher.selector);
        reg.publish(bytes32(uint256(1)), bytes32(uint256(2)), "u");
    }

    function testIdsStartAtOneAndIncrement() public {
        vm.prank(PUB);
        require(reg.publish(bytes32(uint256(1)), bytes32(uint256(2)), "a") == 1, "id1");
        vm.prank(PUB);
        require(reg.publish(bytes32(uint256(3)), bytes32(uint256(4)), "b") == 2, "id2");
        require(reg.releaseCount() == 2, "count");
    }

    function testEmitsEvent() public {
        vm.expectEmit(true, true, true, true, address(reg));
        emit ReleasePublished(1, bytes32(uint256(7)), bytes32(uint256(8)), "ipfs://x", PUB);
        vm.prank(PUB);
        reg.publish(bytes32(uint256(7)), bytes32(uint256(8)), "ipfs://x");
    }

    function testGetAndLatest() public {
        vm.warp(1000);
        vm.prank(PUB);
        reg.publish(bytes32(uint256(1)), bytes32(uint256(2)), "a");
        vm.warp(2000);
        vm.prank(PUB);
        reg.publish(bytes32(uint256(3)), bytes32(uint256(4)), "bb");

        (bytes32 c, bytes32 b, string memory u, uint64 t, address p) = reg.getRelease(1);
        require(c == bytes32(uint256(1)) && b == bytes32(uint256(2)), "r1");
        require(keccak256(bytes(u)) == keccak256("a") && t == 1000 && p == PUB, "r1b");

        (uint256 id, bytes32 c2, bytes32 b2, string memory u2, uint64 t2, address p2) =
            reg.latestRelease();
        require(id == 2 && c2 == bytes32(uint256(3)) && b2 == bytes32(uint256(4)), "latest");
        require(keccak256(bytes(u2)) == keccak256("bb") && t2 == 2000 && p2 == PUB, "latestb");
    }

    function testLatestEmptyReturnsZero() public view {
        (uint256 id,,,,,) = reg.latestRelease();
        require(id == 0, "empty");
    }

    function testGetUnknownReverts() public {
        vm.expectRevert(DeployRegistry.UnknownRelease.selector);
        reg.getRelease(0);
        vm.expectRevert(DeployRegistry.UnknownRelease.selector);
        reg.getRelease(1);
    }

    function testTransferOwnership() public {
        vm.prank(OWNER);
        reg.transferOwnership(STRANGER);
        require(reg.owner() == STRANGER, "owner");
        vm.prank(OWNER);
        vm.expectRevert(DeployRegistry.NotOwner.selector);
        reg.setPublisher(OWNER, true);
    }
}
