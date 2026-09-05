export const SAFE_FACTORY_ABI = [
  'function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address proxy, address singleton)'
]

export const SAFE_ABI = [
  'function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver) external',
  'function getOwners() external view returns (address[])',
  'function getThreshold() external view returns (uint256)',
  'function nonce() external view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) public view returns (bytes32)',
  'function approvedHashes(address signer, bytes32 txHash) public view returns (uint256)',
  'function approveHash(bytes32 hashToApprove) external',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes memory signatures) public payable returns (bool success)',
  'function isOwner(address owner) public view returns (bool)',
  'function enableModule(address module) external',
  'function disableModule(address prevModule, address module) external',
  'function getModulesPaginated(address start, uint256 pageSize) external view returns (address[] memory array, address next)',
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
  'event ApproveHash(bytes32 indexed approvedHash, address indexed owner)',
  'event SignMsg(bytes32 indexed msgHash)',
  'event AddedOwner(address owner)',
  'event RemovedOwner(address owner)',
  'event ChangedThreshold(uint256 threshold)'
]

export const ERC20_ABI = [
  'function name() public view returns (string)',
  'function symbol() public view returns (string)',
  'function decimals() public view returns (uint8)',
  'function totalSupply() public view returns (uint256)',
  'function balanceOf(address _owner) public view returns (uint256 balance)',
  'function transfer(address _to, uint256 _value) public returns (bool success)',
  'function transferFrom(address _from, address _to, uint256 _value) public returns (bool success)',
  'function approve(address _spender, uint256 _value) public returns (bool success)',
  'function allowance(address _owner, address _spender) public view returns (uint256 remaining)',
  'event Transfer(address indexed _from, address indexed _to, uint256 _value)',
  'event Approval(address indexed _owner, address indexed _spender, uint256 _value)'
]

export const SAFE_TX_TYPE = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' }
  ]
} as const

export const SAFE_EIP712_DOMAIN = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' }
  ]
} as const

export const SAFE_VERSION = '1.3.0'
export const SAFE_NAME = 'Safe'
