package com.example.inventory;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/inventory")
public class InventoryController {

    @GetMapping("/{itemId}")
    public String getStock(@PathVariable String itemId) {
        return "100";
    }

    @PostMapping("/restock")
    public String restock(@RequestBody String body) {
        return "restocked";
    }
}
