package com.example.order;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private InventoryClient inventoryClient;

    @GetMapping("/{id}")
    public String getOrder(@PathVariable String id) {
        return inventoryClient.checkStock(id);
    }

    @PostMapping
    public String createOrder(@RequestBody String body) {
        return "created";
    }
}
