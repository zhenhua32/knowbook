#include <node.h>

namespace knowbook_native_acceptance {
void Initialize(v8::Local<v8::Object> exports) {
  auto* isolate = exports->GetIsolate();
  auto context = isolate->GetCurrentContext();
  exports->Set(context, v8::String::NewFromUtf8Literal(isolate, "compiledAbi"),
               v8::Integer::New(isolate, NODE_MODULE_VERSION)).Check();
  exports->Set(context, v8::String::NewFromUtf8Literal(isolate, "answer"),
               v8::Integer::New(isolate, 42)).Check();
}

// Deliberately use the versioned Node ABI, rather than ABI-stable Node-API.
NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)
}
